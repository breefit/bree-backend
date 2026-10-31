class CloudinaryStorage {
  constructor({ cloudinary, params = {} }) {
    if (!cloudinary) {
      throw new Error("`cloudinary` option required");
    }

    this.cloudinary = cloudinary;
    this.params = params;
  }

  async _handleFile(req, file, callback) {
    let response;
    try {
      const uploadOptions = {};
      for (const [key, value] of Object.entries(this.params)) {
        uploadOptions[key] =
          typeof value === "function" ? await value(req, file) : value;
      }

      response = await new Promise((resolve, reject) => {
        const uploadStream = this.cloudinary.uploader.upload_stream(
          uploadOptions,
          (error, result) => {
            if (error) {
              reject(error);
            } else {
              resolve(result);
            }
          },
        );
        file.stream.pipe(uploadStream);
      });
    } catch (error) {
      callback(error);
      return;
    }

    callback(null, {
      path: response.secure_url,
      size: response.bytes,
      filename: response.public_id,
    });
  }

  _removeFile(req, file, callback) {
    this.cloudinary.uploader.destroy(
      file.filename,
      { invalidate: true },
      callback,
    );
  }
}

export default CloudinaryStorage;
