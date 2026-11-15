"""Per-category mandatory attributes for agent product drafts.

The agent Add Product flow is CATEGORY-FIRST: the agent picks a category, and
only the fields that actually matter for that category are asked for. This
module is the single source of truth for that schema — the agent categories API
serves it to the mobile form, and the create/resubmit endpoints validate the
same definition server-side (a client can never skip a mandatory attribute).

Design notes
------------
* Unknown / newly created categories deliberately have NO extra fields. That
  keeps future categories usable without a code change and never blocks the
  existing draft flow.
* Values are stored in ``product_content``:
    - ``specifications`` (JSON, label -> value) for technical attributes,
    - ``compatibility`` for "compatible phone model" style fields,
    - ``warranty_info`` for the warranty field.
  Everything lands in the columns the storefront tabs already read, so the
  manager completion and admin approval flows keep working unchanged.
"""

import re

WARRANTY_OPTIONS = [
    "No Warranty",
    "3 Months",
    "6 Months",
    "1 Year",
    "2 Years",
]

_MATERIAL_OPTIONS = [
    "Silicone",
    "TPU",
    "Hard Plastic",
    "Metal",
    "Leather",
    "Fabric",
    "Rubber",
    "Glass",
    "Other",
]


def _normalize(value):
    """Category names differ in case/spacing/punctuation across DBs."""
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _field(key, label, kind="text", options=None, placeholder="", column="specifications"):
    return {
        "key": key,
        "label": label,
        "type": kind,          # text | select | number
        "options": list(options or []),
        "placeholder": placeholder,
        "required": True,
        "column": column,      # internal — not sent to clients
    }


def _warranty():
    return _field(
        "warranty",
        "Warranty",
        "select",
        WARRANTY_OPTIONS,
        column="warranty_info",
    )


def _serial():
    return _field(
        "serial_number",
        "Serial / IMEI Number",
        "text",
        placeholder="Printed on the product or its box",
    )


_SCHEMA = {
    "chargers": [
        _field("output_wattage", "Output Wattage", "select",
               ["10W", "18W", "20W", "25W", "33W", "45W", "65W", "100W+"]),
        _field("port_type", "Port Type", "select",
               ["USB-A", "USB-C", "USB-A + USB-C", "Dual USB-C", "Wireless", "Other"]),
        _field("cable_included", "Cable Included", "select", ["Yes", "No"]),
        _serial(),
        _warranty(),
    ],
    "cables": [
        _field("cable_type", "Cable Type", "select",
               ["USB-C to USB-C", "USB-C to Lightning", "USB-A to USB-C",
                "USB-A to Micro-USB", "USB-A to Lightning", "Other"]),
        _field("length", "Cable Length", "select",
               ["0.5 m", "1 m", "1.5 m", "2 m", "3 m"]),
        _field("max_wattage", "Max Wattage Support", "select",
               ["18W", "33W", "60W", "100W", "240W"]),
        _serial(),
        _warranty(),
    ],
    "earphones": [
        _field("connectivity", "Connectivity", "select", ["Wired", "Bluetooth", "TWS"]),
        _field("battery_backup", "Battery Backup", "select",
               ["Not applicable (wired)", "Up to 10 hrs", "10-20 hrs", "20-30 hrs", "30+ hrs"]),
        _serial(),
        _warranty(),
    ],
    "powerbanks": [
        _field("capacity", "Battery Capacity", "select",
               ["5000 mAh", "10000 mAh", "20000 mAh", "27000 mAh", "30000 mAh+"]),
        _field("output_wattage", "Output Wattage", "select",
               ["10W", "18W", "22.5W", "33W", "45W", "65W+"]),
        _field("output_ports", "Number of Output Ports", "select", ["1", "2", "3", "4+"]),
        _serial(),
        _warranty(),
    ],
    "cases": [
        _field("compatible_model", "Compatible Phone Model", "text",
               placeholder="e.g. iPhone 15 Pro, Galaxy S24 Ultra",
               column="compatibility"),
        _field("case_material", "Case Material", "select",
               ["Silicone", "TPU", "Hard Plastic", "Leather", "Metal", "Hybrid"]),
        _field("color", "Color", "text", placeholder="e.g. Black, Transparent"),
    ],
    "screenprotector": [
        _field("compatible_model", "Compatible Phone Model", "text",
               placeholder="e.g. iPhone 15 Pro, Galaxy S24 Ultra",
               column="compatibility"),
        _field("protector_type", "Protector Type", "select",
               ["Tempered Glass", "Matte", "Privacy", "Film", "Ceramic"]),
        _field("pack_size", "Pack Size", "select",
               ["1 Pack", "2 Pack", "3 Pack", "5 Pack"]),
    ],
    "cameralens": [
        _field("compatible_model", "Compatible Phone Model", "text",
               placeholder="e.g. iPhone 15 Pro, Galaxy S24 Ultra",
               column="compatibility"),
        _field("lens_type", "Lens Type", "select",
               ["Wide Angle", "Macro", "Telephoto", "Fisheye", "Zoom"]),
        _field("magnification", "Magnification", "text", placeholder="e.g. 2x, 10x"),
        _warranty(),
    ],
    "accessories": [
        _field("accessory_type", "Accessory Type", "text",
               placeholder="e.g. Ring Holder, Phone Stand, Selfie Stick"),
        _field("material", "Material", "select", _MATERIAL_OPTIONS),
        _field("color", "Color", "text", placeholder="e.g. Black, Silver"),
        _warranty(),
    ],
    "stickers": [
        _field("pack_size", "Pack Size", "select",
               ["1 Sheet", "5 Sheets", "10 Sheets", "Custom"]),
        _field("material", "Material", "select",
               ["Vinyl", "Paper", "Glossy", "Matte", "Holographic"]),
    ],
    # Device categories are not in the catalogue today, but agents sell phones
    # through the same panel when the manager creates the category. IMEI is the
    # one identifier that must never be skipped.
    "mobiles": [
        _field("imei", "IMEI Number", "text",
               placeholder="15-digit IMEI printed on the box"),
        _field("storage", "Storage", "select",
               ["32 GB", "64 GB", "128 GB", "256 GB", "512 GB", "1 TB"]),
        _field("color", "Color", "text", placeholder="e.g. Celadon Marble"),
        _field("condition", "Condition", "select", ["New", "Open Box", "Refurbished"]),
        _warranty(),
    ],
    "tablets": [
        _field("serial_number", "Serial / IMEI Number", "text",
               placeholder="Printed on the box"),
        _field("storage", "Storage", "select",
               ["32 GB", "64 GB", "128 GB", "256 GB", "512 GB", "1 TB"]),
        _field("color", "Color", "text", placeholder="e.g. Space Grey"),
        _warranty(),
    ],
}


# Normalized aliases → schema key. Covers plurals, common spellings and the
# "Camera Lance" naming used by the admin panel.
_ALIASES = {
    "charger": "chargers", "chargers": "chargers", "adapter": "chargers",
    "poweradapter": "chargers", "poweradapters": "chargers",
    "cable": "cables", "cables": "cables", "chargingcable": "cables",
    "chargingcables": "cables", "datacable": "cables",
    "earphone": "earphones", "earphones": "earphones", "earbud": "earphones",
    "earbuds": "earphones", "headphone": "earphones", "headphones": "earphones",
    "tws": "earphones", "twsbuds": "earphones",
    "powerbank": "powerbanks", "powerbanks": "powerbanks",
    "case": "cases", "cases": "cases", "cover": "cases", "covers": "cases",
    "backcover": "cases", "backcovers": "cases", "phonecase": "cases",
    "screenprotector": "screenprotector", "screenprotectors": "screenprotector",
    "temperedglass": "screenprotector", "screenprotection": "screenprotector",
    "cameralance": "cameralens", "cameralances": "cameralens",
    "cameralens": "cameralens", "cameralenses": "cameralens",
    "camera": "cameralens",
    "accessory": "accessories", "accessories": "accessories",
    "sticker": "stickers", "stickers": "stickers",
    "mobile": "mobiles", "mobiles": "mobiles", "mobilephone": "mobiles",
    "mobilephones": "mobiles", "smartphone": "mobiles", "smartphones": "mobiles",
    "phone": "mobiles", "phones": "mobiles",
    "tablet": "tablets", "tablets": "tablets", "ipad": "tablets",
}

_SPEC_KEY = "specifications"
_COMPAT_KEY = "compatibility"
_WARRANTY_KEY = "warranty_info"


def schema_key(category_name):
    """Schema bucket for a category name, or None when it has no extras."""
    normalized = _normalize(category_name)
    if not normalized:
        return None
    key = _ALIASES.get(normalized, normalized)
    return key if key in _SCHEMA else None


def fields_for_category(category_name):
    """Internal field list (kept for validation)."""
    key = schema_key(category_name)
    return list(_SCHEMA.get(key, [])) if key else []


def public_fields(category_name):
    """Field list safe to serve to the client (drops storage internals)."""
    return [
        {k: v for k, v in field.items() if k != "column"}
        for field in fields_for_category(category_name)
    ]


def validate_attributes(category_name, attributes):
    """Validate the agent's category attributes.

    Returns ``(content, error)`` where ``content`` is::

        {"specifications": {label: value}, "compatibility": str|None,
         "warranty_info": str|None}

    ``error`` is a human-readable message when a mandatory field is missing or
    invalid. Unknown extra keys are ignored on purpose — older clients and new
    categories stay compatible.
    """
    fields = fields_for_category(category_name)
    content = {_SPEC_KEY: {}, _COMPAT_KEY: None, _WARRANTY_KEY: None}
    if not fields:
        return content, None

    raw = attributes if isinstance(attributes, dict) else {}
    for field in fields:
        value = raw.get(field["key"])
        text = str(value).strip() if value is not None else ""
        if not text:
            return None, f"'{field['label']}' is required for {category_name} listings"
        max_len = 500 if field.get("column") == _COMPAT_KEY else 120
        if len(text) > max_len:
            text = text[:max_len]

        if field["type"] == "select":
            match = next(
                (opt for opt in field["options"] if opt.lower() == text.lower()),
                None,
            )
            if match is None:
                return None, f"Choose a valid {field['label']} option for {category_name}"
            text = match
        elif field["type"] == "number":
            if not re.fullmatch(r"[0-9]+(\.[0-9]+)?", text):
                return None, f"{field['label']} must be a number"

        column = field.get("column") or _SPEC_KEY
        if column == _COMPAT_KEY:
            content[_COMPAT_KEY] = text
        elif column == _WARRANTY_KEY:
            content[_WARRANTY_KEY] = text
        else:
            content[_SPEC_KEY][field["label"]] = text

    return content, None


def attributes_from_content(category_name, specifications, compatibility, warranty_info):
    """Rebuild the keyed attribute object from stored content (for redo/drafts)."""
    fields = fields_for_category(category_name)
    if not fields:
        return {}

    if isinstance(specifications, str):
        import json
        try:
            specifications = json.loads(specifications) if specifications else {}
        except Exception:
            specifications = {}
    specs = specifications if isinstance(specifications, dict) else {}

    values = {}
    for field in fields:
        column = field.get("column") or _SPEC_KEY
        if column == _COMPAT_KEY:
            value = compatibility
        elif column == _WARRANTY_KEY:
            value = warranty_info
        else:
            value = specs.get(field["label"])
        if value:
            values[field["key"]] = str(value)
    return values
