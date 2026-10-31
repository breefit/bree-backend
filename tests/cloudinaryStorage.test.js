import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import CloudinaryStorage from "../src/utils/cloudinaryStorage.js";

test("Cloudinary storage streams uploads and returns Multer file metadata", async () => {
  const uploaded = [];
  const cloudinary = {
    uploader: {
      upload_stream(options, callback) {
        uploaded.push(options);
        const stream = new PassThrough();
        stream.resume();
        stream.on("finish", () => {
          callback(null, {
            secure_url: "https://res.cloudinary.test/image.jpg",
            bytes: 42,
            public_id: "bree-products/image",
          });
        });
        return stream;
      },
    },
  };
  const storage = new CloudinaryStorage({
    cloudinary,
    params: {
      folder: (req) => req.folder,
      allowed_formats: ["jpg", "png"],
    },
  });
  const fileStream = new PassThrough();
  const resultPromise = new Promise((resolve, reject) => {
    storage._handleFile(
      { folder: "bree-products" },
      { stream: fileStream },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });

  fileStream.end("image bytes");
  assert.deepEqual(await resultPromise, {
    path: "https://res.cloudinary.test/image.jpg",
    size: 42,
    filename: "bree-products/image",
  });
  assert.deepEqual(uploaded, [
    { folder: "bree-products", allowed_formats: ["jpg", "png"] },
  ]);
});

test("Cloudinary storage propagates upload errors", async () => {
  const uploadError = new Error("upload failed");
  const storage = new CloudinaryStorage({
    cloudinary: {
      uploader: {
        upload_stream(_options, callback) {
          const stream = new PassThrough();
          callback(uploadError);
          return stream;
        },
      },
    },
  });
  const fileStream = new PassThrough();
  const resultPromise = new Promise((resolve) => {
    storage._handleFile({}, { stream: fileStream }, (error) => resolve(error));
  });

  fileStream.end("image bytes");
  assert.equal(await resultPromise, uploadError);
});

test("Cloudinary storage removes uploaded assets with cache invalidation", async () => {
  let removed;
  const storage = new CloudinaryStorage({
    cloudinary: {
      uploader: {
        destroy(...args) {
          removed = args;
          args[2](null, { result: "ok" });
        },
      },
    },
  });
  const result = await new Promise((resolve, reject) => {
    storage._removeFile({}, { filename: "bree-products/image" }, (error, value) =>
      error ? reject(error) : resolve(value),
    );
  });

  assert.deepEqual(removed.slice(0, 2), [
    "bree-products/image",
    { invalidate: true },
  ]);
  assert.deepEqual(result, { result: "ok" });
});
