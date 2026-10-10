"""Export Unity objects using the separately provisioned UnityPy interpreter."""
import argparse
import collections
import hashlib
import importlib.metadata
import json
import re
import struct
from pathlib import Path


def safe(value):
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', str(value)).strip('.')[:100] or 'unnamed'


def candidates(root):
    for source in sorted(Path(root).rglob('*')):
        if not source.is_file():
            continue
        with source.open('rb') as stream:
            header = stream.read(48)
        if header.startswith((b'UnityFS\0', b'UnityWeb\0', b'UnityRaw\0')):
            yield source
            continue
        # SerializedFile headers, not extensions or sample-specific filenames.
        if len(header) < 20:
            continue
        metadata, size, version, offset = struct.unpack_from('>IIII', header)
        if not 9 <= version <= 22 or header[16] not in (0, 1):
            continue
        header_size = 20
        if version == 22:
            if len(header) < 48:
                continue
            metadata, size, offset = struct.unpack_from('>IQQ', header, 20)
            header_size = 48
        if size == source.stat().st_size and header_size <= offset < size and 0 < metadata <= offset - header_size:
            yield source


def version_for(obj):
    asset = obj.assets_file
    value = getattr(asset, 'unity_version', None)
    if not value:
        value = getattr(getattr(asset, 'header', None), 'unity_version', None)
    return str(value) if value else None


def verified_tree(obj, generator_version):
    head = obj.parse_monobehaviour_head()
    nodes = obj.generate_monobehaviour_node()
    patched = False
    # Only this known upstream version has the observed base-header alignment bug.
    if generator_version == '0.0.10':
        from UnityPy.helpers.TypeTreeNode import TypeTreeNode
        flat = []
        for child in nodes.traverse():
            fields = {k: getattr(child, k) for k in ('m_Level', 'm_Type', 'm_Name', 'm_MetaFlag')}
            if child.m_Level == 1 and child.m_Name == 'm_Enabled' and child.m_Type in ('UInt8', 'bool'):
                fields['m_MetaFlag'] |= 0x4000
                patched = True
            flat.append(fields)
        nodes = TypeTreeNode.from_list(flat)
    tree = obj.read_typetree(nodes=nodes)
    verify_header(obj, tree, head)
    return tree, patched


def verify_header(obj, tree, head=None):
    if head is None:
        head = obj.parse_monobehaviour_head()
    for field in ('m_GameObject', 'm_Script'):
        pointer = getattr(head, field)
        if tree.get(field) != {'m_FileID': pointer.m_FileID, 'm_PathID': pointer.m_PathID}:
            raise ValueError('MonoBehaviour header verification failed: ' + field)
    if tree.get('m_Name') != head.m_Name or tree.get('m_Enabled') != head.m_Enabled:
        raise ValueError('MonoBehaviour header verification failed: name/enabled')


def export(root, output, evidence):
    import UnityPy
    root, output = Path(root), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    records, errors, inputs, versions = [], [], [], set()
    try:
        generator_version = importlib.metadata.version('TypeTreeGeneratorAPI')
    except importlib.metadata.PackageNotFoundError:
        generator_version = None
    managed = sorted({p.parent for p in root.rglob('*.dll') if any(part.lower() == 'managed' for part in p.parts)})
    generators = {}
    for source in candidates(root):
        relative = source.relative_to(root).as_posix()
        inputs.append(relative)
        try:
            env = UnityPy.load(str(source))
            for ordinal, obj in enumerate(env.objects):
                kind = obj.type.name
                version = version_for(obj)
                if version:
                    versions.add(version)
                asset_name = str(obj.assets_file.name)
                asset_key = safe(asset_name) + '_' + hashlib.sha256(asset_name.encode()).hexdigest()[:10]
                bundle_key = safe(relative) + '_' + hashlib.sha256(relative.encode()).hexdigest()[:12]
                key = asset_key + '_' + str(obj.path_id) + '_' + str(ordinal)
                directory = output / bundle_key / safe(kind)
                directory.mkdir(parents=True, exist_ok=True)
                record = {'source': relative, 'asset': asset_name, 'path_id': obj.path_id, 'type': kind,
                          'unity_version': version}
                try:
                    if kind == 'MonoBehaviour':
                        # Embedded type trees need no generated header workaround.
                        embedded = getattr(getattr(obj, 'serialized_type', None), 'node', None)
                        if embedded is not None:
                            tree = obj.read_typetree(nodes=embedded)
                            verify_header(obj, tree)
                            record.update(tree_source='embedded', header_verified=True, alignment_fix=False)
                        else:
                            if not version or not managed:
                                raise ValueError('generated MonoBehaviour tree requires detected Unity version and managed DLLs')
                            if version not in generators:
                                from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator
                                generator = TypeTreeGenerator(version)
                                for folder in managed:
                                    generator.load_local_dll_folder(str(folder))
                                generators[version] = generator
                            env.typetree_generator = generators[version]
                            tree, patched = verified_tree(obj, generator_version)
                            record.update(header_verified=True, alignment_fix=patched, tree_source='generated')
                    else:
                        tree = obj.read_typetree()
                    record['name'] = tree.get('m_Name', '') if isinstance(tree, dict) else ''
                    target = directory / (key + '.json')
                    target.write_text(json.dumps(tree, ensure_ascii=True, indent=2, default=str), encoding='utf-8')
                    record['tree'] = target.relative_to(output.parent).as_posix()
                except Exception as exc:
                    record['tree_error'] = str(exc)
                    errors.append({'source': relative, 'key': key, 'phase': 'tree', 'error': str(exc)})
                    try:
                        target = directory / (key + '.bin')
                        target.write_bytes(obj.get_raw_data())
                        record['raw'] = target.relative_to(output.parent).as_posix()
                    except Exception as raw_exc:
                        errors.append({'source': relative, 'key': key, 'phase': 'raw', 'error': str(raw_exc)})
                if kind in ('Texture2D', 'Sprite', 'TextAsset', 'AudioClip'):
                    try:
                        data = obj.read()
                        name = key + '_' + safe(getattr(data, 'm_Name', kind))
                        if kind in ('Texture2D', 'Sprite'):
                            data.image.save(directory / (name + '.png'))
                        elif kind == 'TextAsset':
                            content = data.m_Script
                            (directory / (name + '.txt')).write_bytes(content.encode('utf-8', 'surrogateescape') if isinstance(content, str) else content)
                        else:
                            for index, (sample_name, content) in enumerate(data.samples.items()):
                                (directory / (name + '_' + str(index) + '_' + safe(sample_name))).write_bytes(content)
                    except Exception as exc:
                        errors.append({'source': relative, 'key': key, 'phase': 'media', 'error': str(exc)})
                records.append(record)
            if not env.objects:
                errors.append({'source': relative, 'phase': 'load', 'error': 'no serialized objects found'})
        except Exception as exc:
            errors.append({'source': relative, 'phase': 'load', 'error': str(exc)})
    if not inputs:
        errors.append({'phase': 'discovery', 'error': 'no supported Unity serialized assets or bundles found'})
    elif not records:
        errors.append({'phase': 'export', 'error': 'no Unity objects exported'})
    result = {'inputs': inputs, 'objects': records, 'errors': errors, 'unity_versions': sorted(versions),
              'generator_version': generator_version, 'counts': dict(collections.Counter(r['type'] for r in records))}
    Path(evidence).write_text(json.dumps(result, ensure_ascii=True, indent=2), encoding='utf-8')
    return 2 if errors else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    return export(args.input, args.output, args.evidence)


if __name__ == '__main__':
    raise SystemExit(main())
