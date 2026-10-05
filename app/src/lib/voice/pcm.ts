export function encodePcm(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodePcm(base64: string): Float32Array<ArrayBuffer> {
  const binary = atob(base64);
  if (binary.length % 2 !== 0 || binary.length > 1024 * 1024)
    throw new Error("Invalid audio frame.");
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(binary.length / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}
