#!/usr/bin/env python3
"""Generate vectors/canonicalization.json with an implementation of
w3-text-v1 that is independent of the JavaScript library (Python
unicodedata + hashlib), so the JS tests byte-check against a second
implementation rather than against themselves.

Rules (SPEC.md 4.1, as implemented):
  strip one leading BOM, NFC, CRLF/CR -> LF, strip trailing spaces
  and tabs per line, drop trailing empty lines, end with a single LF;
  empty result is zero bytes.

Run: python3 generate_vectors.py
"""

import base64
import hashlib
import json
import unicodedata


def canonicalize(text: str) -> bytes:
    if text.startswith("\ufeff"):
        text = text[1:]
    text = unicodedata.normalize("NFC", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip(" \t") for line in text.split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    if not lines:
        return b""
    return ("\n".join(lines) + "\n").encode("utf-8")


CASES = [
    ("basic-lf", "Hello, world.\nSecond line.\n"),
    ("crlf-and-cr", "Line one\r\nLine two\rLine three\r\n"),
    ("trailing-whitespace", "Title   \nBody\t \n"),
    ("trailing-blank-lines", "Text\n\n\n\n"),
    ("missing-final-newline", "No newline at end"),
    ("empty", ""),
    ("blank-only", "\n\n \n\t\n"),
    ("nfc-combining", "Cafe\u0301 au lait\n"),
    ("bom-prefixed", "\ufeffHeading\nBody\n"),
    ("zero-width-preserved", "a\u200bb\n"),
    ("interior-blanks-preserved", "Para one\n\n\nPara two\n"),
    ("leading-whitespace-preserved", "  indented\n\ttabbed\n"),
    ("emoji", "Sealed \u2705\n"),
    ("mixed-endings-and-blanks", "One\r\nTwo\n\nThree   \r\n\r\n"),
]

vectors = []
for name, source in CASES:
    canonical = canonicalize(source)
    vectors.append(
        {
            "name": name,
            "input_b64": base64.b64encode(source.encode("utf-8")).decode(),
            "canonical_b64": base64.b64encode(canonical).decode(),
            "canonical_sha256": hashlib.sha256(canonical).hexdigest(),
        }
    )

out = {
    "c14n": "w3-text-v1",
    "generated_by": "vectors/generate_vectors.py (Python, independent implementation)",
    "vectors": vectors,
}

with open("canonicalization.json", "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
    f.write("\n")

print(f"wrote {len(vectors)} vectors to canonicalization.json")
