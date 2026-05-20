import { query } from '../../config/database.js';
import { cloudinary } from '../../config/cloudinary.js';
import cache from '../../utils/cache.js';

const slugify = (name) =>
  name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

const VALID_PRODUCT_STATUSES = ['In Stock', 'Out Of Stock'];
const normalizeProductStatus = (status) =>
  VALID_PRODUCT_STATUSES.includes(status) ? status : 'In Stock';

const resolveProductStatus = (stockQty, status) => {
  const parsedQty = Number(stockQty);
  if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
    return 'Out Of Stock';
  }
  return status !== undefined ? normalizeProductStatus(status) : 'In Stock';
};

const invalidateProductCache = () => {
  cache.delPrefix('products:');
  cache.del('home:data');
};

// Helper to emit Socket.IO event
const emitProductEvent = (req, eventType, product) => {
  try {
    const io = req.app.locals.io;
    if (io) {
      io.emit(`product:${eventType}`, product);
      console.log(`📡 Emitted: product:${eventType}`);
    }
  } catch (err) {
    console.warn('Socket.IO emit failed (non-critical):', err.message);
  }
};

// GET /api/admin/products
export const getProducts = async (req, res) => {
  const { page = 1, limit = 20, search = '' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const where  = search ? `WHERE name ILIKE $1` : '';
  const params = search ? [`%${search}%`, parseInt(limit), offset] : [parseInt(limit), offset];
  const pIdx   = search ? { limit: '$2', offset: '$3' } : { limit: '$1', offset: '$2' };

  const [productsRes, countRes] = await Promise.all([
    query(
      `SELECT id, name, slug, category, description, price::float, mrp::float,
              quantity, stock_qty, image, features, popular, status, is_active, created_at
       FROM products ${where} ORDER BY created_at DESC
       LIMIT ${pIdx.limit} OFFSET ${pIdx.offset}`,
      params
    ),
    query(`SELECT COUNT(*)::int AS total FROM products ${where}`, search ? [`%${search}%`] : []),
  ]);

  res.json({
    products: productsRes.rows,
    total:    countRes.rows[0].total,
    pages:    Math.ceil(countRes.rows[0].total / parseInt(limit)),
  });
};

// POST /api/admin/products
export const createProduct = async (req, res) => {
  const { name, category, description, price, mrp, quantity, features, popular, status, stockQty } = req.body;
  const image = req.file?.path || req.body.image || '';
  const slug  = slugify(name);

  const featuresArr = Array.isArray(features)
    ? features
    : (features ? features.split(',').map((f) => f.trim()) : []);

  const stockQuantity = parseInt(stockQty || 0, 10);
  const productStatus = resolveProductStatus(stockQuantity, status);

  const { rows } = await query(
    `INSERT INTO products
       (name, slug, category, description, price, mrp, quantity,
        stock_qty, image, features, popular, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      name, slug, category, description,
      parseFloat(price), parseFloat(mrp || price),
      parseInt(quantity), stockQuantity,
      image, featuresArr,
      popular === 'true' || popular === true,
      productStatus,
    ]
  );
  invalidateProductCache();
  emitProductEvent(req, 'created', rows[0]);
  res.status(201).json(rows[0]);
};

// PUT /api/admin/products/:id
export const updateProduct = async (req, res) => {
  const { name, category, description, price, mrp, quantity, features, popular, status, stockQty, isActive } = req.body;

  const updates = ['updated_at = now()'];
  const params  = [];
  let   idx     = 1;

  const add = (col, val) => { updates.push(`${col} = $${idx++}`); params.push(val); };

  if (name        !== undefined) { add('name', name); add('slug', slugify(name)); }
  if (category    !== undefined) add('category',    category);
  if (description !== undefined) add('description', description);
  if (price       !== undefined) add('price',       parseFloat(price));
  if (mrp         !== undefined) add('mrp',         parseFloat(mrp));
  if (quantity    !== undefined) add('quantity',    parseInt(quantity));
  if (popular     !== undefined) add('popular',     popular === 'true' || popular === true);
  if (isActive    !== undefined) add('is_active',   isActive === 'true' || isActive === true);
  if (req.file)                  add('image',       req.file.path);

  if (features !== undefined) {
    const arr = Array.isArray(features)
      ? features
      : features.split(',').map((f) => f.trim());
    add('features', arr);
  }

  const parsedStockQty = stockQty !== undefined ? parseInt(stockQty, 10) : undefined;
  const explicitStatus = status !== undefined ? normalizeProductStatus(status) : undefined;

  if (stockQty !== undefined) {
    add('stock_qty', Number.isFinite(parsedStockQty) ? parsedStockQty : 0);
  }

  const resolvedStatus = stockQty !== undefined
    ? parsedStockQty <= 0
      ? 'Out Of Stock'
      : explicitStatus ?? 'In Stock'
    : explicitStatus;

  if (resolvedStatus !== undefined) {
    add('status', resolvedStatus);
  }

  params.push(req.params.id);
  const { rows } = await query(
    `UPDATE products SET ${updates.join(', ')} WHERE id=$${idx} RETURNING *`,
    params
  );
  if (!rows.length) return res.status(404).json({ message: 'Product not found' });
  invalidateProductCache();
  emitProductEvent(req, 'updated', rows[0]);
  res.json(rows[0]);
};

// DELETE /api/admin/products/:id  — soft delete to preserve order history
export const deleteProduct = async (req, res) => {
  const { rows } = await query(
    'UPDATE products SET is_active=false, updated_at=now() WHERE id=$1 RETURNING id, image',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ message: 'Product not found' });

  invalidateProductCache();
  emitProductEvent(req, 'deleted', { id: rows[0].id });

  // Optionally delete from Cloudinary
  if (rows[0].image?.includes('cloudinary.com')) {
    const publicId = rows[0].image.split('/').pop().split('.')[0];
    cloudinary.uploader.destroy(`${process.env.CLOUDINARY_UPLOAD_FOLDER || 'bree-products'}/${publicId}`)
      .catch(() => {}); // non-blocking
  }

  res.json({ message: 'Product deactivated' });
};

// POST /api/admin/products/:id/relations
// Body: [{ related_product_id, relation_type, weight }, ...]
export const setProductRelations = async (req, res) => {
  const productId = req.params.id;
  const relations = Array.isArray(req.body.relations) ? req.body.relations : [];

  // Validate product exists
  const { rows: p } = await query('SELECT id FROM products WHERE id=$1 LIMIT 1', [productId]);
  if (!p.length) return res.status(404).json({ message: 'Product not found' });

  // Delete existing relations for product, then insert new ones (simple replace semantics)
  await query('DELETE FROM product_relations WHERE product_id=$1', [productId]);

  if (relations.length === 0) {
    invalidateProductCache();
    return res.json({ message: 'Relations cleared' });
  }

  const inserts = relations.map((r, i) => {
    const relId = r.related_product_id;
    const type = r.relation_type || 'recommend';
    const weight = parseInt(r.weight || 0);
    return query(
      `INSERT INTO product_relations (product_id, related_product_id, relation_type, weight) VALUES ($1,$2,$3,$4)`,
      [productId, relId, type, weight]
    );
  });

  await Promise.all(inserts);
  invalidateProductCache();
  res.json({ message: 'Relations set' });
};

// DELETE /api/admin/products/:id/relations/:relId
export const deleteProductRelation = async (req, res) => {
  const { id, relId } = req.params;
  const { rows } = await query('DELETE FROM product_relations WHERE product_id=$1 AND related_product_id=$2 RETURNING id', [id, relId]);
  if (!rows.length) return res.status(404).json({ message: 'Relation not found' });
  invalidateProductCache();
  res.json({ message: 'Relation deleted' });
};

// GET /api/admin/products/:id/relations
export const getProductRelations = async (req, res) => {
  const productId = req.params.id;

  const { rows } = await query(
    `SELECT pr.related_product_id AS id,
            p.name,
            p.slug,
            p.image,
            pr.relation_type,
            pr.weight
     FROM product_relations pr
     JOIN products p ON p.id = pr.related_product_id
     WHERE pr.product_id = $1
     ORDER BY pr.weight DESC, p.name ASC`,
    [productId]
  );

  res.json(rows);
};
