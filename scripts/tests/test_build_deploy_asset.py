"""Tests for scripts/release/build-deploy-asset.sh and vercel_build_output.py.

The packer and its checks run against small synthetic Build Output
directories, so these tests need no npm, network or Vercel CLI. The shell
script is tested only up to the point where it would start building: its
argument handling, the environment it refuses, the host platform it refuses,
and the files it never replaces. docs/releasing.md describes a full local run.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

RELEASE_DIR = Path(__file__).resolve().parents[1] / "release"
SCRIPT = RELEASE_DIR / "build-deploy-asset.sh"
PACKER = RELEASE_DIR / "vercel_build_output.py"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
MTIME = 1_760_000_000
# The Test workflow sets this, so that a missing shellcheck fails the gate
# instead of silently skipping the lint check.
REQUIRE_TOOLS = os.environ.get("MGM_TEST_REQUIRE_TOOLS") == "1"


def needs(*tools):
    """Skips a test whose tools are missing, unless the run requires them."""
    missing = [tool for tool in tools if not shutil.which(tool)]
    return unittest.skipIf(bool(missing) and not REQUIRE_TOOLS, f"not installed: {', '.join(missing)}")


def elf_header(machine, bits=64):
    """The first 20 bytes of a little-endian ELF file for the given machine."""
    return b"\x7fELF" + bytes([2 if bits == 64 else 1, 1, 1]) + bytes(9) + (3).to_bytes(2, "little") + machine.to_bytes(2, "little")


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))


def make_output(root, target="production", architecture="x86_64", runtime="nodejs24.x"):
    """A small Build Output directory shaped like `vercel build --standalone`'s."""
    write_json(root / "config.json", {"version": 3, "routes": []})
    write_json(root / "builds.json", {
        "target": target,
        "cliVersion": "65.1.0",
        "builds": [{"use": "@vercel/next", "requirePath": str(root / "missing" / "dist" / "index.js")}],
    })
    (root / "static").mkdir()
    (root / "static" / "favicon.ico").write_bytes(b"icon")
    func = root / "functions" / "api" / "pay.func"
    write_json(func / ".vc-config.json", {
        "runtime": runtime, "architecture": architecture, "handler": "___next_launcher.cjs",
        "framework": {"slug": "nextjs", "version": "16.4.1"},
    })
    launcher = func / "___next_launcher.cjs"
    launcher.write_text("module.exports = {}\n")
    launcher.chmod(0o755)
    (func / ".env.local.example").write_text("EXAMPLE=1\n")
    native = func / "node_modules" / "argon2" / "prebuilds" / "linux-x64" / "argon2.glibc.node"
    native.parent.mkdir(parents=True)
    native.write_bytes(elf_header(62) + b"\0" * 64)
    # A route alias, as `vercel build` writes them: a relative symlink to a
    # function directory.
    os.symlink("pay.func", root / "functions" / "api" / "pay.rsc.func")
    write_json(root / "functions" / "middleware.func" / ".vc-config.json", {
        "runtime": "edge", "entrypoint": "index.js", "framework": {"slug": "nextjs", "version": "16.4.1"},
    })
    (root / "functions" / "middleware.func" / "index.js").write_text("export default () => {}\n")


class PackerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mgm-asset-test."))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.output = self.tmp / "output"
        make_output(self.output)

    def pack(self, output=None, name="asset.tar.gz", extra=(), target="production"):
        archive = self.tmp / name
        info = self.tmp / (name + ".json")
        result = subprocess.run(
            [sys.executable, "-I", str(PACKER), str(output or self.output), str(archive),
             "--info", str(info), "--version", "v0.0.1", "--commit", COMMIT, "--mtime", str(MTIME),
             "--target", target, "--node-runtime", "nodejs24.x", "--vercel-cli", "65.1.0", *extra],
            capture_output=True, text=True, timeout=60,
        )
        return result, archive, info

    def assert_refused(self, message, extra=("--require-linux-x64",), target="production"):
        result, archive, _ = self.pack(extra=extra, target=target)
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn(message, result.stderr)
        self.assertFalse(archive.exists())

    def test_packs_and_reports(self):
        result, archive, info = self.pack(extra=["--require-linux-x64"])
        self.assertEqual(result.returncode, 0, result.stderr)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(result.stdout.strip(), digest)
        data = json.loads(info.read_text())
        self.assertEqual(data["sha256"], digest)
        self.assertEqual(data["commit"], COMMIT)
        self.assertEqual(data["target"], "production")
        self.assertEqual(data["functions"], {"nodejs": 1, "edge": 1, "other": 0, "aliases": 1})
        self.assertEqual(data["runtimes"], ["edge", "nodejs24.x"])
        self.assertEqual(data["architectures"], ["x86_64"])
        self.assertEqual(data["builders"], [{"use": "@vercel/next", "version": None}])
        self.assertEqual(data["frameworks"], ["nextjs 16.4.1"])
        self.assertEqual(
            data["nativeBinaries"],
            [{"path": "functions/api/pay.func/node_modules/argon2/prebuilds/linux-x64/argon2.glibc.node",
              "format": "ELF 64-bit x86-64"}],
        )

    def test_archive_entries_are_normalised_and_relative(self):
        result, archive, _ = self.pack()
        self.assertEqual(result.returncode, 0, result.stderr)
        raw = archive.read_bytes()
        # gzip header: no FNAME flag, zero MTIME.
        self.assertEqual(raw[3] & 0x08, 0)
        self.assertEqual(raw[4:8], b"\0\0\0\0")
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
        names = [m.name for m in members]
        self.assertEqual(names, sorted(names))
        self.assertIn("config.json", names)
        self.assertTrue(all(not n.startswith(("/", "./", "..")) for n in names))
        for member in members:
            self.assertEqual((member.uid, member.gid, member.uname, member.gname), (0, 0, "", ""))
            self.assertEqual(member.mtime, MTIME)
        by_name = {m.name: m for m in members}
        self.assertTrue(by_name["functions/api/pay.rsc.func"].issym())
        self.assertEqual(by_name["functions/api/pay.rsc.func"].linkname, "pay.func")
        self.assertEqual(by_name["functions/api/pay.func/___next_launcher.cjs"].mode, 0o755)
        self.assertEqual(by_name["config.json"].mode, 0o644)
        self.assertEqual(by_name["static"].mode, 0o755)

    def test_extracts_to_the_same_tree(self):
        result, archive, _ = self.pack()
        self.assertEqual(result.returncode, 0, result.stderr)
        extracted = self.tmp / "extracted"
        extracted.mkdir()
        with tarfile.open(archive) as tar:
            tar.extractall(extracted, filter="data")
        for path in self.output.rglob("*"):
            rel = path.relative_to(self.output)
            twin = extracted / rel
            if path.is_symlink():
                self.assertEqual(os.readlink(twin), os.readlink(path))
            elif path.is_file():
                self.assertEqual(twin.read_bytes(), path.read_bytes(), rel)

    def test_same_output_packs_to_the_same_bytes(self):
        first, archive, _ = self.pack()
        self.assertEqual(first.returncode, 0, first.stderr)
        # A copy with other timestamps, other inodes and a hard link packs the same.
        copy = self.tmp / "copy"
        shutil.copytree(self.output, copy, symlinks=True)
        for path in copy.rglob("*"):
            if not path.is_symlink():
                os.utime(path, (1, 1))
        twin = copy / "static" / "favicon.ico"
        twin.unlink()
        os.link(self.output / "static" / "favicon.ico", twin)
        second, second_archive, _ = self.pack(output=copy, name="again.tar.gz")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(archive.read_bytes(), second_archive.read_bytes())

    def test_refuses_a_target_other_than_requested(self):
        self.assert_refused("expected 'preview'", target="preview")

    def test_refuses_a_function_that_reads_outside_the_output(self):
        config = self.output / "functions" / "api" / "pay.func" / ".vc-config.json"
        data = json.loads(config.read_text())
        data["filePathMap"] = {"node_modules/x/index.js": "node_modules/x/index.js"}
        config.write_text(json.dumps(data))
        self.assert_refused("--standalone")

    def test_refuses_an_arm64_function(self):
        shutil.rmtree(self.output)
        make_output(self.output, architecture="arm64")
        self.assert_refused("architecture arm64")

    def test_allows_an_arm64_function_without_requiring_linux_x64(self):
        shutil.rmtree(self.output)
        make_output(self.output, architecture="arm64")
        result, _, info = self.pack()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(info.read_text())["architectures"], ["arm64"])

    def test_refuses_a_function_on_another_node_runtime(self):
        shutil.rmtree(self.output)
        make_output(self.output, runtime="nodejs22.x")
        self.assert_refused("runtime nodejs22.x, expected nodejs24.x", extra=())

    def test_refuses_native_modules_for_other_platforms(self):
        native = next(self.output.rglob("*.node"))
        for content, text in [
            (b"\xcf\xfa\xed\xfe" + bytes(28), "Mach-O"),
            (elf_header(183) + bytes(8), "ELF 64-bit aarch64"),
            (b"MZ" + bytes(30), "not an ELF or Mach-O binary"),
        ]:
            with self.subTest(text):
                native.write_bytes(content)
                self.assert_refused(text)

    def test_refuses_symlinks_that_leave_the_output(self):
        link = self.output / "functions" / "api" / "escape.func"
        for target, message in [
            ("../../../outside", "resolves outside the output"),
            ("/etc", "absolute path"),
            ("missing.func", "missing entry"),
        ]:
            with self.subTest(target):
                if link.is_symlink():
                    link.unlink()
                os.symlink(target, link)
                (self.tmp / "outside").mkdir(exist_ok=True)
                self.assert_refused(message, extra=())

    def test_refuses_an_environment_file(self):
        (self.output / "functions" / "api" / "pay.func" / ".env.production").write_text("X=1\n")
        self.assert_refused("an environment file must not be part of the asset", extra=())

    def test_refuses_an_output_without_functions(self):
        shutil.rmtree(self.output / "functions")
        self.assert_refused("no functions", extra=())

    def test_refuses_a_different_cli_version(self):
        builds = self.output / "builds.json"
        data = json.loads(builds.read_text())
        data["cliVersion"] = "64.0.0"
        builds.write_text(json.dumps(data))
        self.assert_refused("Vercel CLI '64.0.0'", extra=())


class ScriptTest(unittest.TestCase):
    """The script's refusals, all of which happen before anything is built."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mgm-asset-script-test."))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.out = self.tmp / "out"
        # Pretends the host is an Apple Silicon Mac.
        self.fake_bin = self.tmp / "bin"
        self.fake_bin.mkdir()
        uname = self.fake_bin / "uname"
        uname.write_text('#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac\n')
        uname.chmod(0o755)

    def run_script(self, *args, extra_env=None, fake_host=False):
        # An explicit environment: the Test workflow's own MGM_TEST_* variables
        # must not reach the script, which refuses MGM_* names.
        env = {"PATH": os.environ["PATH"], "HOME": str(self.tmp), "TMPDIR": str(self.tmp)}
        if fake_host:
            env["PATH"] = f"{self.fake_bin}{os.pathsep}{env['PATH']}"
        env.update(extra_env or {})
        return subprocess.run(
            ["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=60,
        )

    def assert_nothing_started(self):
        self.assertFalse(self.out.exists())
        self.assertEqual([p.name for p in self.tmp.glob("mgm-release.*")], [])

    def test_help(self):
        result = self.run_script("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Usage: build-deploy-asset.sh", result.stdout)

    def test_usage_errors(self):
        for args in [
            (),
            ("--out", "x"),
            ("--version", "v0.0.1"),
            ("--version", "0.0.1", "--out", "x"),
            ("--version", "v0.0.1;id", "--out", "x"),
            ("--version", "v0.0.1", "--version", "v0.0.2", "--out", "x"),
            ("--version", "v0.0.1", "--out", "x", "--token=abc"),
        ]:
            with self.subTest(args):
                result = self.run_script(*args)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("abc", result.stderr)
        self.assert_nothing_started()

    def test_refuses_installation_settings_and_credentials(self):
        for name in ["NEXT_PUBLIC_SUPABASE_URL", "MGM_BOOTSTRAP_TOKEN", "SUPABASE_SERVICE_ROLE_KEY",
                     "VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]:
            with self.subTest(name):
                secret = "value-that-must-not-be-printed"
                result = self.run_script("--version", "v0.0.1", "--out", str(self.out), extra_env={name: secret})
                self.assertEqual(result.returncode, 3, result.stderr)
                self.assertIn(name, result.stderr)
                self.assertNotIn(secret, result.stderr + result.stdout)
        self.assert_nothing_started()

    def test_does_not_refuse_unrelated_vercel_variables(self):
        result = self.run_script(
            "--version", "v0.0.1", "--out", str(self.out),
            extra_env={"VERCEL_TELEMETRY_DISABLED": "1"}, fake_host=True,
        )
        # Gets as far as the platform check.
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("--allow-foreign-platform", result.stderr)

    def test_refuses_a_host_other_than_linux_x64(self):
        result = self.run_script("--version", "v0.0.1", "--out", str(self.out), fake_host=True)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("Darwin arm64", result.stderr)
        self.assertIn("--allow-foreign-platform", result.stderr)
        self.assert_nothing_started()

    def test_never_replaces_an_existing_asset(self):
        self.out.mkdir()
        existing = self.out / "mgm-vercel-output-v0.0.1-local-darwin-arm64.tar.gz"
        existing.write_bytes(b"published")
        result = self.run_script(
            "--version", "v0.0.1", "--out", str(self.out), "--allow-foreign-platform", fake_host=True,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("already exists", result.stderr)
        self.assertEqual(existing.read_bytes(), b"published")
        self.assertEqual([p.name for p in self.tmp.glob("mgm-release.*")], [])

    def test_names_preview_assets(self):
        self.out.mkdir()
        existing = self.out / "mgm-vercel-output-v0.0.1-preview-local-darwin-arm64.build-info.json"
        existing.write_text("{}")
        result = self.run_script(
            "--version", "v0.0.1", "--out", str(self.out), "--preview", "--allow-foreign-platform",
            fake_host=True,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn(existing.name, result.stderr)

    def test_refuses_an_unknown_commit(self):
        result = self.run_script(
            "--version", "v0.0.1", "--out", str(self.out), "--ref", "no-such-ref-for-this-test",
            "--allow-foreign-platform", fake_host=True,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn("not a commit", result.stderr)

    @needs("shellcheck")
    def test_shellcheck_clean(self):
        self.assertTrue(shutil.which("shellcheck"), "shellcheck is not installed")
        result = subprocess.run(["shellcheck", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
