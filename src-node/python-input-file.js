const CHUNK_BYTES = 1024 * 1024;

// Emscripten's regular MEMFS node handles names, permissions, seek and stat.
// Reads use the backing file until the script explicitly changes its contents.
export function attachPythonInput(fs, filePath, attachment) {
  const source = attachment.readInto ? attachment : bufferSource(attachment.buffer);
  const node = fs.create(filePath);
  const operations = node.stream_ops;
  const attributes = node.node_ops;
  let backed = true;
  node.usedBytes = source.size;

  function materialize(keep = source.size) {
    if (!backed) return;
    const size = Math.min(source.size, keep);
    const contents = new Uint8Array(size);
    readAll(source, contents, 0, size, 0);
    node.contents = contents;
    node.usedBytes = size;
    backed = false;
  }

  node.stream_ops = {
    ...operations,
    read(stream, buffer, offset, length, position) {
      if (!backed) return operations.read(stream, buffer, offset, length, position);
      const count = Math.max(0, Math.min(length, source.size - position));
      readAll(source, buffer, offset, count, position);
      return count;
    },
    write(...args) {
      materialize();
      return operations.write(...args);
    },
    allocate(...args) {
      materialize();
      return operations.allocate(...args);
    },
    mmap(...args) {
      materialize();
      return operations.mmap(...args);
    },
  };
  node.node_ops = {
    ...attributes,
    setattr(target, attrs) {
      if (attrs.size !== undefined && attrs.size !== node.usedBytes) materialize(attrs.size);
      return attributes.setattr(target, attrs);
    },
  };
  return {
    sameContents(fs, filePath, size) {
      if (size !== source.size) return false;
      if (backed && fs.lookupPath(filePath).node === node) return true;
      const expected = new Uint8Array(Math.min(CHUNK_BYTES, size));
      const actual = new Uint8Array(expected.length);
      const stream = fs.open(filePath, "r");
      try {
        for (let position = 0; position < size; position += expected.length) {
          const length = Math.min(expected.length, size - position);
          readAll(source, expected, 0, length, position);
          if (fs.read(stream, actual, 0, length, position) !== length) return false;
          for (let index = 0; index < length; index++) if (actual[index] !== expected[index]) return false;
        }
        return true;
      } finally {
        fs.close(stream);
      }
    },
  };
}

function readAll(source, buffer, offset, count, position) {
  let read = 0;
  while (read < count) {
    const length = Math.min(CHUNK_BYTES, count - read);
    const bytesRead = source.readInto(buffer, offset + read, length, position + read);
    if (bytesRead <= 0) throw new Error("Python input ended unexpectedly.");
    read += bytesRead;
  }
}

function bufferSource(buffer) {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
  return {
    size: bytes.byteLength,
    readInto(destination, offset, count, position) {
      destination.set(bytes.subarray(position, position + count), offset);
      return count;
    },
  };
}
