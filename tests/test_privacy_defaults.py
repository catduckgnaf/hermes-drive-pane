import ast
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PrivacyDefaultsTest(unittest.TestCase):
    def test_public_defaults_are_synthetic_and_configurable(self):
        backend = ast.parse((ROOT / "dashboard/plugin_api.py").read_text())
        defaults = next(
            node.value for node in backend.body
            if isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "DEFAULT_ROOTS"
                    for target in node.targets)
        )
        self.assertEqual(
            ast.literal_eval(defaults),
            [{"label": "Files", "path": "/srv/files", "key": "files", "local": {}}],
        )

        metadata = (ROOT / "plugin.yaml").read_text()
        readme = (ROOT / "README.md").read_text()
        source = (ROOT / "desktop/plugin.src.js").read_text()
        self.assertIn("path: /srv/files", metadata)
        self.assertIn("/srv/files", readme)
        bundle = (ROOT / "desktop/plugin.js").read_text()
        bundle = re.sub(r"// node_modules/.*?(?=\\n)", "", bundle)
        self.assertIn('label: "Files"', bundle)

        site_specific = re.compile(
            r"(?:/" + "home/[^\\s]+|/" + "mnt/[^\\s]+|"
            r"(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)"
            r"\.\d{1,3}\.\d{1,3})",
            re.I,
        )
        self.assertIsNotNone(site_specific.search("/" + "home/operator/files"))
        self.assertIsNotNone(site_specific.search("/" + "mnt/example"))
        self.assertIsNotNone(site_specific.search("192.168" + ".0.1"))
        for path in (
            ROOT / "README.md",
            ROOT / "dashboard/plugin_api.py",
            ROOT / "desktop/plugin.js",
            ROOT / "plugin.yaml",
        ):
            with self.subTest(path=path.name):
                self.assertIsNone(site_specific.search(path.read_text()))


if __name__ == "__main__":
    unittest.main()
