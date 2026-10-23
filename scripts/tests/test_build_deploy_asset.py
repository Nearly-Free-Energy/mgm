"""Tests for scripts/release/build-deploy-asset.sh, vercel_build_output.py,
third_party_notices.py and the pins in .github/workflows/release.yml.

The packer, its checks and the notices writer run against small synthetic
Build Output and project directories, so these tests need no npm, network or
Vercel CLI. The shell
script is tested only up to the point where it would start building: its
argument handling, the environment it refuses, the host platform it refuses,
and the files it never replaces. docs/releasing.md describes a full local run.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

RELEASE_DIR = Path(__file__).resolve().parents[1] / "release"
SCRIPT = RELEASE_DIR / "build-deploy-asset.sh"
WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "release.yml"
PACKER = RELEASE_DIR / "vercel_build_output.py"
NOTICES = RELEASE_DIR / "third_party_notices.py"
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


def write_package(directory, name, version, licence=None, files=None):
    """An installed npm package: package.json plus the given top-level files."""
    data = {"name": name, "version": version}
    if licence is not None:
        data["license"] = licence
    write_json(directory / "package.json", data)
    for file_name, text in (files or {}).items():
        path = directory / file_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def make_notices_fixture(tmp):
    """A Build Output directory and the project directory it was built in.

    - argon2 and shared-* are in the function's node_modules, without their
      licence files, as `vercel build --standalone` copies them;
    - bundled is only in a server chunk, named by the chunk's source map, which
      the build left in the project's .next directory;
    - next is in the function, and its prebuilt runtime bundles the
      react-dom copy it vendors under dist/compiled, named by the runtime's
      installed source map;
    - that react-dom's browser build loads the scheduler next vendors beside
      it, which nothing else names; next's own code loads another vendored
      directory, which is not listed for it;
    - the build manifest names a polyfill file in static/_next, whose
      packages come from the supplement, which records its SHA-256;
    - styles is imported by the project's stylesheet;
    - unused is installed but in none of these.

    Returns (output, project, supplement).
    """
    output = tmp / "output"
    project = tmp / "project"
    make_output(output)
    modules = project / "node_modules"
    write_package(modules / "argon2", "argon2", "0.44.0", "MIT", {"LICENSE": "argon2 licence\n"})
    shared = "Shared licence text\n\nCopyright (c) Example\n"
    write_package(modules / "@scope" / "shared-a", "@scope/shared-a", "1.0.0", "MIT", {"LICENSE": shared})
    write_package(modules / "shared-b", "shared-b", "2.0.0", "MIT",
                  {"LICENCE.md": shared.replace("\n", "  \r\n") + "\r\n\r\n"})
    write_package(modules / "bundled", "bundled", "3.0.0", "Apache-2.0",
                  {"LICENSE": "Apache licence text\n", "NOTICE": "bundled notice\n", "license.js": "code"})
    write_package(modules / "nolicence", "nolicence", "1.0.0", "ISC")
    write_package(modules / "next", "next", "16.4.1", "MIT", {"license.md": "next licence\n"})
    compiled = modules / "next" / "dist" / "compiled"
    write_package(compiled / "react-dom", "react-dom-builtin", "0.0.0", None, {
        "LICENSE": "react-dom licence\n",
        "cjs/react-dom-client.production.js":
            'var s=require("next/dist/compiled/scheduler"),n=require("next/dist/lib/not-vendored");\n',
    })
    # Vendored like react-dom, but its package.json has only a name.
    write_json(compiled / "scheduler" / "package.json", {"name": "scheduler-builtin"})
    (compiled / "scheduler" / "LICENSE").write_text("react-dom licence\n")
    (compiled / "scheduler" / "cjs").mkdir()
    (compiled / "scheduler" / "cjs" / "scheduler.production.js").write_text("exports.unstable_now=0\n")
    write_package(compiled / "unloaded", "unloaded-builtin", "0.0.0", None, {"LICENSE": "unloaded licence\n"})
    (modules / "next" / "dist" / "server").mkdir(parents=True)
    (modules / "next" / "dist" / "server" / "next.js").write_text('require("next/dist/compiled/unloaded")\n')
    polyfill = b"!function(){/* polyfills */}();\n"
    (modules / "next" / "dist" / "build" / "polyfills").mkdir(parents=True)
    (modules / "next" / "dist" / "build" / "polyfills" / "polyfill-nomodule.js").write_bytes(polyfill)
    write_package(modules / "styles", "styles", "1.1.0", "MIT", {"LICENSE": "styles licence\n"})
    write_package(modules / "unused", "unused", "9.9.9", "MIT", {"LICENSE": "unused licence\n"})
    (project / "src" / "app").mkdir(parents=True)
    (project / "src" / "app" / "globals.css").write_text('@import "styles";\n@import "./local.css";\n')

    func = output / "functions" / "api" / "pay.func"
    for name in ["argon2", "@scope/shared-a", "shared-b", "nolicence"]:
        shipped = func / "node_modules" / name
        shipped.mkdir(parents=True, exist_ok=True)
        shutil.copy(modules / name / "package.json", shipped / "package.json")
    runtime = func / "node_modules" / "next" / "dist" / "compiled" / "next-server" / "runtime.prod.js"
    runtime.parent.mkdir(parents=True)
    runtime.write_text("module.exports={}\n//# sourceMappingURL=runtime.prod.js.map\n")
    shutil.copy(modules / "next" / "package.json", func / "node_modules" / "next" / "package.json")
    installed_runtime = modules / "next" / "dist" / "compiled" / "next-server"
    installed_runtime.mkdir(parents=True)
    write_json(installed_runtime / "runtime.prod.js.map", {"version": 3, "sources": [
        "webpack://next/./src/server/base-server.ts",
        "webpack://next/./dist/compiled/react-dom/cjs/react-dom.production.js",
    ], "mappings": ""})
    # A package that keeps the comment but not the map.
    (func / "node_modules" / "nolicence" / "index.js").write_text("//# sourceMappingURL=index.js.map\n")

    chunk = func / ".next" / "server" / "chunks" / "ssr" / "page._.js"
    chunk.parent.mkdir(parents=True)
    chunk.write_text("module.exports=[]\n//# sourceMappingURL=page._.js.map\n")
    build_chunks = project / ".next" / "server" / "chunks" / "ssr"
    build_chunks.mkdir(parents=True)
    write_json(build_chunks / "page._.js.map", {"version": 3, "sections": [
        {"offset": {"line": 0, "column": 0}, "map": {"version": 3, "mappings": "", "sources": [
            "../../../../src/app/page.tsx",
            "../../../../node_modules/bundled/dist/index.js",
            "../../../../node_modules/src/not-a-package.ts",
        ]}},
    ]})

    builder = tmp / "cli" / "node_modules" / "@vercel" / "next"
    write_package(builder, "@vercel/next", "26.0.0", "Apache-2.0", {"LICENSE": "builder licence\n"})
    (builder / "dist").mkdir()
    builds = json.loads((output / "builds.json").read_text())
    builds["builds"][0]["requirePath"] = str(builder / "dist" / "index.js")
    write_json(output / "builds.json", builds)

    chunks = output / "static" / "_next" / "static" / "chunks"
    chunks.mkdir(parents=True)
    (chunks / "0polyfill.js").write_bytes(polyfill)
    (chunks / "1main.js").write_text("self.main=1\n")
    write_json(project / ".next" / "build-manifest.json", {
        "polyfillFiles": ["static/chunks/0polyfill.js"], "rootMainFiles": ["static/chunks/1main.js"],
    })
    supplement = tmp / "supplement"
    write_json(supplement / "supplement.json", {"bundles": [{
        "file": "node_modules/next/dist/build/polyfills/polyfill-nomodule.js",
        "sha256": hashlib.sha256(polyfill).hexdigest(),
        "packages": [
            {"name": "core-js", "version": "3.38.1", "license": "MIT", "texts": ["core-js-3.38.1/LICENSE"]},
            {"name": "whatwg-fetch", "version": "3.0.0", "license": "MIT", "texts": ["whatwg-fetch-3.0.0/LICENSE"]},
        ],
    }]})
    (supplement / "core-js-3.38.1").mkdir()
    (supplement / "core-js-3.38.1" / "LICENSE").write_text("core-js licence\n")
    (supplement / "whatwg-fetch-3.0.0").mkdir()
    (supplement / "whatwg-fetch-3.0.0" / "LICENSE").write_text("whatwg-fetch licence\n")
    return output, project, supplement


class NoticesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="mgm-notices-test."))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.output, self.project, self.supplement = make_notices_fixture(self.tmp)

    def write(self, name="notices.txt", output=None, supplement=True):
        """Runs the writer; supplement=False uses the supplement it ships with."""
        notices = self.tmp / name
        extra = ["--supplement", str(self.supplement)] if supplement else []
        result = subprocess.run(
            [sys.executable, "-I", str(NOTICES), str(output or self.output), str(notices),
             "--project", str(self.project), "--asset", "mgm-vercel-output-v0.0.1.tar.gz",
             "--version", "v0.0.1", "--commit", COMMIT, *extra],
            capture_output=True, text=True, timeout=60,
        )
        return result, notices

    def packages(self, text):
        listed = text.split("\nPackages\n--------\n\n", 1)[1].split("\nTexts\n-----\n", 1)[0]
        return {block.split("\n", 1)[0]: block for block in listed.strip().split("\n\n")}

    def test_lists_every_package_in_the_asset(self):
        result, notices = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = notices.read_text()
        self.assertEqual(result.stdout.strip(), hashlib.sha256(notices.read_bytes()).hexdigest())
        self.assertTrue(text.startswith("Third-party notices for MGM v0.0.1\n"))
        self.assertIn(COMMIT, text)
        polyfill = "part of next 16.4.1, bundled into dist/build/polyfills/polyfill-nomodule.js"
        self.assertEqual(sorted(self.packages(text)), sorted([
            "@scope/shared-a 1.0.0",
            "@vercel/next 26.0.0 (builder; writes each function's launcher)",
            "argon2 0.44.0",
            "bundled 3.0.0",
            f"core-js 3.38.1 ({polyfill})",
            "next 16.4.1",
            "nolicence 1.0.0",
            "react-dom-builtin 0.0.0 (part of next 16.4.1, at dist/compiled/react-dom)",
            "scheduler-builtin (part of next 16.4.1, at dist/compiled/scheduler)",
            "shared-b 2.0.0",
            "styles 1.1.0",
            f"whatwg-fetch 3.0.0 ({polyfill})",
        ]))
        self.assertNotIn("unused", text)
        self.assertNotIn("unloaded", text)
        self.assertNotIn("not-vendored", text)
        self.assertIn("Packages: 12\n", text)
        # A source-map path that is no installed package is reported, not listed.
        self.assertIn("skipped node_modules/src", result.stderr)

    def test_prints_each_licence_and_notice_in_full(self):
        result, notices = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = notices.read_text()
        packages = self.packages(text)
        self.assertIn("Licence: Apache-2.0", packages["bundled 3.0.0"])
        self.assertRegex(packages["bundled 3.0.0"], r"Texts: \[\d+\] LICENSE, \[\d+\] NOTICE")
        for body in ["argon2 licence", "Apache licence text", "bundled notice", "next licence",
                     "react-dom licence", "styles licence", "builder licence", "core-js licence",
                     "whatwg-fetch licence"]:
            self.assertEqual(text.count(body), 1, body)
        self.assertNotIn("license.js", text)

    def test_lists_the_vendored_directories_a_listed_one_loads(self):
        result, notices = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = notices.read_text()
        block = self.packages(text)["scheduler-builtin (part of next 16.4.1, at dist/compiled/scheduler)"]
        self.assertIn("Licence: not declared in package.json", block)
        # The scheduler ships React's licence, so it cites the text react-dom does.
        cited = re.search(r"Texts: \[(\d+)\] LICENSE", block).group(1)
        react_dom = self.packages(text)["react-dom-builtin 0.0.0 (part of next 16.4.1, at dist/compiled/react-dom)"]
        self.assertIn(f"[{cited}] LICENSE", react_dom)

    def test_lists_the_packages_bundled_into_a_polyfill_file(self):
        result, notices = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        packages = self.packages(notices.read_text())
        polyfill = "part of next 16.4.1, bundled into dist/build/polyfills/polyfill-nomodule.js"
        for name in [f"core-js 3.38.1 ({polyfill})", f"whatwg-fetch 3.0.0 ({polyfill})"]:
            self.assertIn("Licence: MIT", packages[name])
            self.assertRegex(packages[name], r"Texts: \[\d+\] LICENSE")

    def test_refuses_a_polyfill_file_the_supplement_does_not_record(self):
        chunk = self.output / "static" / "_next" / "static" / "chunks" / "0polyfill.js"
        chunk.write_bytes(chunk.read_bytes() + b"/* a newer bundle */\n")
        result, notices = self.write()
        self.assertEqual(result.returncode, 4, result.stderr)
        digest = hashlib.sha256(chunk.read_bytes()).hexdigest()
        self.assertIn(f"static/_next/static/chunks/0polyfill.js: the build manifest names it as a polyfill file, "
                      f"and {self.supplement / 'supplement.json'} records no bundle with its SHA-256 {digest}",
                      result.stderr)
        self.assertFalse(notices.exists())

    def test_refuses_an_output_whose_build_manifest_is_missing(self):
        (self.project / ".next" / "build-manifest.json").unlink()
        result, notices = self.write()
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn(".next/build-manifest.json is unreadable", result.stderr)
        self.assertFalse(notices.exists())

    def test_refuses_a_supplement_text_that_is_missing(self):
        (self.supplement / "whatwg-fetch-3.0.0" / "LICENSE").unlink()
        result, notices = self.write()
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("whatwg-fetch-3.0.0/LICENSE: unreadable", result.stderr)
        self.assertFalse(notices.exists())

    def test_reads_the_supplement_it_ships_with(self):
        # The fixture's polyfill file is not one the shipped supplement records,
        # so the run stops, but only for that: the supplement itself is read.
        result, notices = self.write(supplement=False)
        self.assertEqual(result.returncode, 4, result.stderr)
        problems = [line for line in result.stderr.splitlines() if "check failed" in line]
        self.assertEqual(len(problems), 1, result.stderr)
        self.assertIn(f"{RELEASE_DIR / 'notices-supplement' / 'supplement.json'} records no bundle", problems[0])
        self.assertFalse(notices.exists())

    def test_the_shipped_supplement_names_files_it_contains(self):
        directory = RELEASE_DIR / "notices-supplement"
        bundles = json.loads((directory / "supplement.json").read_text())["bundles"]
        self.assertTrue(bundles)
        for bundle in bundles:
            self.assertRegex(bundle["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(bundle["file"].startswith("node_modules/"), bundle["file"])
            for package in bundle["packages"]:
                self.assertTrue(package["name"] and package["version"] and package["license"], package)
                for text in package["texts"]:
                    self.assertIn("Copyright", (directory / text).read_text(), text)

    def test_prints_identical_texts_once(self):
        result, notices = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = notices.read_text()
        # CRLF line endings, trailing spaces and blank lines do not make a new text.
        self.assertEqual(text.count("Shared licence text"), 1)
        packages = self.packages(text)
        cited_a = re.search(r"\[(\d+)\] LICENSE", packages["@scope/shared-a 1.0.0"]).group(1)
        cited_b = re.search(r"\[(\d+)\] LICENCE.md", packages["shared-b 2.0.0"]).group(1)
        self.assertEqual(cited_a, cited_b)
        self.assertIn(f"[{cited_a}] @scope/shared-a 1.0.0: LICENSE; shared-b 2.0.0: LICENCE.md", text)

    def test_notes_a_package_without_a_licence_file(self):
        result, notices = self.write()
        self.assertEqual(result.returncode, 0, result.stderr)
        block = self.packages(notices.read_text())["nolicence 1.0.0"]
        self.assertIn("Licence: ISC", block)
        self.assertIn("no licence or notice text is installed with this package", block)
        self.assertNotIn("Texts:", block)

    def test_is_deterministic_and_sorted(self):
        first, notices = self.write()
        self.assertEqual(first.returncode, 0, first.stderr)
        second, again = self.write(name="again.txt")
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(notices.read_bytes(), again.read_bytes())
        names = list(self.packages(notices.read_text()))
        self.assertEqual(names, sorted(names, key=str.lower))

    def test_refuses_a_bundle_whose_source_map_is_missing(self):
        (self.project / ".next" / "server" / "chunks" / "ssr" / "page._.js.map").unlink()
        result, notices = self.write()
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("page._.js.map is neither in the output nor in the project directory", result.stderr)
        self.assertFalse(notices.exists())

    def test_refuses_a_package_that_differs_from_the_installed_one(self):
        shipped = self.output / "functions" / "api" / "pay.func" / "node_modules" / "argon2" / "package.json"
        write_json(shipped, {"name": "argon2", "version": "0.43.0", "license": "MIT"})
        result, notices = self.write()
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("node_modules/argon2: the output's package.json has version '0.43.0'", result.stderr)
        self.assertFalse(notices.exists())

    def test_refuses_an_unknown_builder(self):
        builds = json.loads((self.output / "builds.json").read_text())
        builds["builds"][0]["requirePath"] = str(self.tmp / "missing" / "dist" / "index.js")
        write_json(self.output / "builds.json", builds)
        result, _ = self.write()
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("builder '@vercel/next'", result.stderr)

    def test_refuses_to_write_into_the_output(self):
        result, notices = self.write(name="output/notices.txt")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(notices.exists())


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

    def test_never_replaces_existing_notices(self):
        self.out.mkdir()
        existing = self.out / "mgm-third-party-notices-v0.0.1-local-darwin-arm64.txt"
        existing.write_text("published")
        result = self.run_script(
            "--version", "v0.0.1", "--out", str(self.out), "--allow-foreign-platform", fake_host=True,
        )
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn(existing.name, result.stderr)
        self.assertEqual(existing.read_text(), "published")

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


class WorkflowTest(unittest.TestCase):
    """The pins in the Release workflow."""

    def setUp(self):
        self.lines = WORKFLOW.read_text().splitlines()

    def test_every_action_is_pinned_to_a_commit_with_its_version(self):
        uses = [line.strip() for line in self.lines if re.match(r"\s*(- )?uses:", line)]
        self.assertTrue(uses)
        for line in uses:
            with self.subTest(line):
                self.assertRegex(line, r"^(- )?uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+$")

    def test_every_job_runs_on_a_pinned_image(self):
        runs_on = [line.strip() for line in self.lines if re.match(r"\s*runs-on:", line)]
        self.assertEqual(runs_on, ["runs-on: ubuntu-24.04"] * 2)


if __name__ == "__main__":
    unittest.main()
