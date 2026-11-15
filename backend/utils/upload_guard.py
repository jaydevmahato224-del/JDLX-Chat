"""Upload content sniffing (audit L2).

Upload endpoints historically validated only the file EXTENSION, so a renamed
script/HTML payload passed as ".png". This helper checks the real container
against the declared extension.

The rule is "positively identified as an image" or reject:
  * Pillow (already a runtime dependency) decodes the bytes -> the decoded
    format must be compatible with the declared extension;
  * Pillow cannot decode it -> the raw magic bytes must still look like a known
    image container (this keeps legitimate HEIC/AVIF uploads, which Pillow may
    not decode without plugins, working);
  * anything else (HTML, scripts, archives, plain text) is rejected.
"""
import io

try:  # Pillow ships with the runtime (utils.image_optimizer uses it)
    from PIL import Image

    _HAVE_PIL = True
except Exception:  # pragma: no cover - Pillow missing
    _HAVE_PIL = False


# Formats accepted per declared extension after Pillow decodes the file.
_COMPATIBLE = {
    ".jpg": {"image/jpeg", "image/heic", "image/heif", "image/avif", "image/webp"},
    ".jpeg": {"image/jpeg", "image/heic", "image/heif", "image/avif", "image/webp"},
    ".png": {"image/png", "image/apng"},
    ".webp": {"image/webp"},
    ".gif": {"image/gif"},
}

# Raw magic bytes for "is this an image at all" when Pillow can't decode it.
_IMAGE_MAGIC = (
    b"\xff\xd8\xff",      # JPEG
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"GIF87a",             # GIF
    b"GIF89a",
    b"BM",                 # BMP
    b"II*\x00",            # TIFF
    b"MM\x00*",
)
_RIFF = b"RIFF"
_HEIF_BRANDS = (b"heic", b"heix", b"hevc", b"heim", b"heis", b"mif1", b"msf1", b"avif")


def _looks_like_image(data):
    head = bytes(data[:32])
    if any(head.startswith(sig) for sig in _IMAGE_MAGIC):
        return True
    # WebP: "RIFF....WEBP"
    if head.startswith(_RIFF) and len(data) >= 12 and bytes(data[8:12]) == b"WEBP":
        return True
    # HEIC/AVIF: ISO-BMFF "....ftyp<brand>"
    if len(data) >= 12 and bytes(data[4:8]) == b"ftyp":
        brand = bytes(data[8:12])
        if brand in _HEIF_BRANDS:
            return True
    return False


def image_content_error(data, ext):
    """Returns an error string when the payload is not the declared ``ext``.

    ``ext`` is the lower-cased extension ('.png', '.jpg', '.webp', '.pdf').
    Returns None when the content is acceptable.
    """
    if not data:
        return "Uploaded file is empty"

    ext = (ext or "").lower()

    if ext == ".pdf":
        return None if bytes(data[:5]) == b"%PDF" else "File content is not a valid PDF"

    if ext not in _COMPATIBLE:
        return None  # extension not sniffed here — allow-list already applied

    if _HAVE_PIL:
        try:
            with Image.open(io.BytesIO(data)) as probe:
                fmt = (probe.format or "").lower()
            detected = "image/jpeg" if fmt in ("jpg", "jpeg") else f"image/{fmt}"
            if detected not in _COMPATIBLE[ext]:
                return (
                    f"File content does not match its extension ({detected or 'unknown'} "
                    f"vs {ext}). Please upload the original image."
                )
            return None
        except Exception:
            pass  # undecodable by Pillow -> fall through to the magic-byte test

    if _looks_like_image(data):
        return None
    return "File content is not a valid image. Please upload the original JPG/PNG/WEBP."
