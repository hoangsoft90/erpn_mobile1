import 'dart:typed_data';

import 'package:image_picker/image_picker.dart';

/// C1 (`plan3` Trụ C) — the photo half of the camera channel.
///
/// Kept behind an interface for the same two reasons [SpeechService] is:
/// (a) CI has no camera and no photo library, so tests inject a fake, and
/// (b) swapping the source (system camera today, an in-app `camera` preview
/// later) changes one file instead of the chat screen.
///
/// This interface can ONLY return bytes. It has no notion of what the picture
/// means, no path to `/ask`, and certainly none to `/execute` — the camera is an
/// input modality, not a command.
abstract class PhotoPicker {
  /// Returns the picked photo, or null when the user backed out (a cancel is
  /// not an error and must not produce a request).
  Future<PickedPhoto?> pick();
}

/// One captured/selected photo, already small enough to travel as base64 JSON.
class PickedPhoto {
  const PickedPhoto({required this.bytes, required this.mimeType});

  final Uint8List bytes;

  /// A type the server's `ocr_policy` allowlist accepts (`image/jpeg`,
  /// `image/png`, `image/webp`, `image/heic`, `image/heif`).
  final String mimeType;

  int get byteLength => bytes.length;
}

/// The system implementation: `image_picker` opens the phone's own camera or
/// photo library and hands back a file.
///
/// DOWNSCALING IS NOT COSMETIC. The gateway reads a request body of at most
/// 1 MB (`MAX_BODY` in `http-ask.mjs`) and base64 inflates bytes by ~4/3, so a
/// 3 MB phone photo cannot be sent at all — the socket is reset before any OCR
/// runs (measured in `c1-camera-ocr-endpoint.test.mjs`). Picking at
/// [maxWidth] with [quality] keeps a document photo in the low hundreds of KB,
/// which both fits the transport and is plenty for reading print.
///
/// MIME TYPE IS PICKED FROM THE FILE, never from the name: the server accepts a
/// fixed allowlist, and guessing "jpeg" for a PNG would make a good photo look
/// like a caller mistake.
class SystemPhotoPicker implements PhotoPicker {
  SystemPhotoPicker({ImagePicker? picker}) : _picker = picker ?? ImagePicker();

  final ImagePicker _picker;

  /// First attempt: plenty of detail for an invoice or a receipt.
  static const int maxWidth = 1600;
  static const int quality = 80;

  /// Retry, for the odd photo that is still too heavy (a very detailed page).
  static const int retryMaxWidth = 1024;
  static const int retryQuality = 60;

  /// Stay comfortably under the gateway's 1 MB JSON body limit once base64 has
  /// added its ~33%: 700 KB of bytes ≈ 933 KB encoded.
  static const int maxBytes = 700 * 1024;

  @override
  Future<PickedPhoto?> pick() async {
    final first = await _capture(maxWidth, quality);
    if (first == null) return null;
    if (first.byteLength <= maxBytes) return first;
    final smaller = await _capture(retryMaxWidth, retryQuality);
    return smaller ?? first;
  }

  Future<PickedPhoto?> _capture(int width, int quality) async {
    final file = await _picker.pickImage(
      // From the camera by default: the shop owner is standing at the counter
      // with a paper document in hand. (The system UI still offers the gallery
      // in its own picker on most devices.)
      source: ImageSource.camera,
      maxWidth: width.toDouble(),
      imageQuality: quality,
      requestFullMetadata: false,
    );
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    return PickedPhoto(bytes: bytes, mimeType: _mimeFor(bytes, file.mimeType, file.name));
  }

  /// The plugin's own type when it has one, else a magic-byte sniff, else JPEG —
  /// and never anything outside the server's allowlist.
  static const Set<String> allowedMimeTypes = {
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif',
  };

  static String _mimeFor(Uint8List bytes, String? fromPlugin, String? name) {
    final declared = fromPlugin?.toLowerCase();
    if (declared != null && allowedMimeTypes.contains(declared)) return declared;
    final sniffed = _sniff(bytes);
    if (sniffed != null) return sniffed;
    final fromName = _fromName(name);
    if (fromName != null) return fromName;
    return 'image/jpeg';
  }

  /// Magic bytes beat extensions and beat plugin metadata.
  static String? _sniff(Uint8List bytes) {
    if (bytes.length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) {
      return 'image/jpeg';
    }
    if (bytes.length >= 8 &&
        bytes[0] == 0x89 &&
        bytes[1] == 0x50 &&
        bytes[2] == 0x4E &&
        bytes[3] == 0x47) {
      return 'image/png';
    }
    if (bytes.length >= 12 &&
        bytes[8] == 0x57 &&
        bytes[9] == 0x45 &&
        bytes[10] == 0x42 &&
        bytes[11] == 0x50) {
      return 'image/webp';
    }
    if (bytes.length >= 12 &&
        bytes[4] == 0x66 &&
        bytes[5] == 0x74 &&
        bytes[6] == 0x79 &&
        bytes[7] == 0x70) {
      // ISO-BMFF: could be HEIC/HEIF. Either is allowed; HEIC is the common one
      // from an iPhone-sourced gallery file.
      return 'image/heic';
    }
    return null;
  }

  static String? _fromName(String? name) {
    final lower = name?.toLowerCase() ?? '';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.heic')) return 'image/heic';
    if (lower.endsWith('.heif')) return 'image/heif';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    return null;
  }
}
