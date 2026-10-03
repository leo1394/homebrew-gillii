class Gillii < Formula
  desc "Locate, decrypt and restore cached WeChat mini-program packages"
  homepage "https://github.com/leo1394/homebrew-gillii"
  url "https://github.com/leo1394/homebrew-gillii/releases/download/v0.1.0/gillii-0.1.0.tar.gz"
  version "0.1.0"
  sha256 "757a39e90ac8672c245de9ea2df9485fbbf23ef0f11fadf1234514a5e3472398"
  license "GPL-3.0-or-later"

  depends_on "node"

  def install
    libexec.install "bin", "lib", "libexec", "completions", "man", "LICENSE", "THIRD-PARTY.md"
    bin.write_exec_script libexec/"bin/gillii"
    man1.install libexec/"man/gillii.1"
    bash_completion.install (libexec/"completions/gillii.bash") => "gillii"
    zsh_completion.install (libexec/"completions/gillii.zsh") => "_gillii"
    fish_completion.install (libexec/"completions/gillii.fish") => "gillii.fish"
  end

  def caveats
    "Use gillii chase <AppID>; the release includes recovery dependencies."
  end

  test do
    expected = "gillii version 0.1.0 (2026-10-03)\nhttps://github.com/leo1394/homebrew-gillii\n"
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
