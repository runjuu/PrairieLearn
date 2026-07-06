import { isBinaryFile } from 'isbinaryfile';
import mime from 'mime';

const MEDIA_PREFIXES = ['image/', 'audio/', 'video/', 'application/pdf'];
// The video/mp2t mime uses a .ts extension, which conflicts with Typescript files.
// In such cases we fallback to a verification if a file is binary or not
// instead of a blindly trusting the mimetype from the name.
const MEDIA_PREFIX_EXCEPTIONS = ['video/mp2t'];

/**
 * Guesses the mime type for a file based on its name and contents.
 *
 * @param name The file's name
 * @param buffer The file's contents
 * @returns The guessed mime type
 */
export async function guessMimeType(name: string, buffer: Buffer): Promise<string> {
  const mimeType = mime.getType(name);
  if (
    mimeType &&
    MEDIA_PREFIXES.some((p) => mimeType.startsWith(p)) &&
    !MEDIA_PREFIX_EXCEPTIONS.some((p) => mimeType.startsWith(p))
  ) {
    return mimeType;
  }

  const isBinary = await isBinaryFile(buffer);
  return isBinary ? 'application/octet-stream' : 'text/plain';
}
