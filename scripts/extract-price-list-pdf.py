#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


BRANCH_MARKERS = {
    "caloocan/cavite",
    "olongapo/tarlac",
    "legazpi/naga/bohol",
    "cebu/davao/mindoro",
    "other branches",
    "all branches",
    "all",
    "branches",
}

TITLE_MARKERS = {
    "globe:",
    "smart:",
    "ms.",
}

PRICE_TOKEN_RE = re.compile(
    r"^(?:\d+pcs?/p\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?(?:/[a-z]+)?)$",
    re.IGNORECASE,
)


def normalize_name(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text.lower())).strip()


def should_skip_line(line: str) -> bool:
    lower = line.lower().strip()
    if not lower:
        return True
    if any(lower.startswith(marker) for marker in TITLE_MARKERS):
        return True
    if lower in BRANCH_MARKERS:
        return True
    if re.search(r"\b09\d{9}\b", lower):
        return True
    return False


def looks_like_header(line: str) -> bool:
    lower = line.lower().strip()
    if not lower:
        return False
    if should_skip_line(line):
        return False
    if re.search(r"\d", lower):
        return False
    return True


def parse_price_token(token: str):
    if not token:
        return None, None
    value = token.lower().strip()
    unit = None

    # Example: 10pcs/P140
    m_pack = re.search(r"(?:\d+pcs?/p)(\d[\d,]*(?:\.\d+)?)$", value)
    if m_pack:
        return float(m_pack.group(1).replace(",", "")), "pack"

    # Example: 70/m, 50/pc, 2,450/roll
    m_unit = re.search(r"(\d[\d,]*(?:\.\d+)?)/([a-z]+)$", value)
    if m_unit:
        price = float(m_unit.group(1).replace(",", ""))
        raw_unit = m_unit.group(2).lower()
        unit_map = {
            "m": "m",
            "pc": "pc/s",
            "pcs": "pc/s",
            "roll": "roll",
            "set": "set",
        }
        unit = unit_map.get(raw_unit, raw_unit)
        return price, unit

    m_plain = re.search(r"(\d[\d,]*(?:\.\d+)?)$", value)
    if m_plain:
        return float(m_plain.group(1).replace(",", "")), unit

    return None, None


def parse_material_line(line: str):
    text = re.sub(r"\s+", " ", line).strip()
    if should_skip_line(text):
        return None
    parts = text.split(" ")
    end_prices = []
    cursor = len(parts) - 1
    while cursor >= 0:
        token = parts[cursor].strip().lower()
        if PRICE_TOKEN_RE.match(token):
            end_prices.append(parts[cursor].strip())
            cursor -= 1
            continue
        break

    end_prices.reverse()
    if not end_prices:
        return None

    desc = " ".join(parts[: cursor + 1]).strip()
    desc = re.sub(r"\bN/A\b", "", desc, flags=re.IGNORECASE).strip()
    if not desc:
        return None

    chosen_index = 0
    if len(end_prices) >= 2:
        first_token_raw = end_prices[0].strip().lower()
        first_price, _ = parse_price_token(end_prices[0])
        second_price, _ = parse_price_token(end_prices[1])
        if first_price is not None and second_price is not None:
            first_digits = re.sub(r"\D", "", first_token_raw)
            first_is_plain_4digit = (
                "," not in first_token_raw
                and "." not in first_token_raw
                and "/" not in first_token_raw
                and len(first_digits) >= 4
            )

            if (
                (first_price <= 25 and second_price >= 50)
                or (first_price > 0 and second_price >= first_price * 5)
                or (first_is_plain_4digit and second_price <= 2000)
            ):
                chosen_index = 1

    chosen_token = end_prices[chosen_index]
    if chosen_index > 0:
        desc = f"{desc} {' '.join(end_prices[:chosen_index])}".strip()

    price, unit = parse_price_token(chosen_token)
    if price is None:
        return None

    return {
        "materialName": desc,
        "unit": unit,
        "basePrice": round(float(price), 2),
    }


def extract(pdf_path: Path):
    reader = PdfReader(str(pdf_path))
    items = []
    section = None

    for page_no, page in enumerate(reader.pages, start=1):
        raw = page.extract_text() or ""
        lines = [ln.strip() for ln in raw.splitlines()]

        for line_no, line in enumerate(lines, start=1):
            if not line:
                continue
            if looks_like_header(line):
                section = line.strip()
                continue

            parsed = parse_material_line(line)
            if not parsed:
                continue

            parsed["section"] = section
            parsed["sourcePage"] = page_no
            parsed["sourceLine"] = line_no
            items.append(parsed)

    deduped = {}
    for item in items:
        key = normalize_name(item["materialName"])
        if not key:
            continue
        if key not in deduped:
            deduped[key] = item
            continue
        # Prefer item with explicit unit, then higher price if duplicate repeats.
        prev = deduped[key]
        if (not prev.get("unit") and item.get("unit")) or (
            float(item.get("basePrice", 0)) > float(prev.get("basePrice", 0))
        ):
            deduped[key] = item

    return list(deduped.values())


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/extract-price-list-pdf.py <pdf_path> [output_json]")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"PDF not found: {pdf_path}")
        sys.exit(1)

    output = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    rows = extract(pdf_path)

    if output:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(rows, indent=2), encoding="utf-8")

    print(
        json.dumps(
            {
                "pdf": str(pdf_path),
                "materials": len(rows),
                "output": str(output) if output else None,
                "sample": rows[:10],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
