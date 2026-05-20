// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${err.stack || err.message}`);

  // Multer file-size error
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File too large. Maximum 5 MB allowed.' });
  }
  // Multer file-type rejection
  if (err.message?.includes('Only JPEG')) {
    return res.status(400).json({ message: err.message });
  }
  // Express body-parser payloads too large
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ message: 'Request payload too large. Upload an image under 5 MB using multipart/form-data.' });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  // Postgres unique violation
  if (err.code === '23505') {
    return res.status(409).json({ message: 'Resource already exists (duplicate value)' });
  }
  // Postgres foreign key violation
  if (err.code === '23503') {
    return res.status(400).json({ message: 'Referenced resource does not exist' });
  }

  const status  = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';

  res.status(status).json({ message });
};

export default errorHandler;
