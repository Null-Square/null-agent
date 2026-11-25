export async function readDocument(openFile, path) {
  const handle = await openFile(path);
  return await handle.read();
}
