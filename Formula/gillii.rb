class Gillii < Formula
  desc "Recover WeChat mini-programs and statically analyze Android APKs"
  homepage "https://github.com/leo1394/homebrew-gillii"
  url "https://github.com/leo1394/homebrew-gillii/releases/download/v0.2.0/gillii-0.2.0.tar.gz"
  version "0.2.0"
  sha256 "5e7c7c22800590dc986909ab5e5d06d676ac75a257789dd79daf4c174143f7d6"
  license "GPL-3.0-or-later"

  depends_on "node"
  depends_on "python@3.13"

  def install
    libexec.install "bin", "lib", "libexec", "completions", "man", "LICENSE", "THIRD-PARTY.md"
    (bin/"gillii").write <<~EOS
      #!/bin/bash
      export GILLII_APK_LAUNCHER_PYTHON="${GILLII_APK_LAUNCHER_PYTHON:-#{Formula["python@3.13"].opt_bin}/python3.13}"
      exec "#{libexec}/bin/gillii" "$@"
    EOS
    (bin/"gillii").chmod 0755
    man1.install libexec/"man/gillii.1"
    bash_completion.install (libexec/"completions/gillii.bash") => "gillii"
    zsh_completion.install (libexec/"completions/gillii.zsh") => "_gillii"
    fish_completion.install (libexec/"completions/gillii.fish") => "gillii.fish"
  end

  def caveats
    "Use gillii chase <AppID|path/to/app.apk>. APK tools are prepared on demand; JADX requires Java 11+."
  end

  test do
    expected = "gillii version 0.2.0 (2026-10-10)\nhttps://github.com/leo1394/homebrew-gillii\n"
    assert_equal expected, shell_output("#{bin}/gillii version")
    assert_equal expected, shell_output("#{bin}/gillii --version")
    assert_match "Copy, decrypt", shell_output("#{bin}/gillii help chase")
    (testpath/"cache/wx0123456789abcdef/1").mkpath
    (testpath/"cache/wx0123456789abcdef/1/__APP__.wxapkg").write "fixture"
    result = JSON.parse(shell_output("#{bin}/gillii info wx0123456789abcdef --root #{testpath}/cache"))
    assert_equal "wx0123456789abcdef", result.fetch("packages").first.fetch("appid")
    assert_match "version", shell_output("#{bin}/gillii versoin 2>&1", 1)
    assert_path_exists man1/"gillii.1"
    assert_path_exists bash_completion/"gillii"
    assert_path_exists zsh_completion/"_gillii"
    assert_path_exists fish_completion/"gillii.fish"
  end
end
