import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { adminLogin, adminMe, adminLogout } from '../../controllers/admin/loginController.js';
import { getDashboardStats } from '../../controllers/admin/dashboardController.js';
import { getOrders, getOrder, updateOrderStatus, bulkUpdateStatus } from '../../controllers/admin/orderController.js';
import { getProducts, createProduct, updateProduct, deleteProduct, setProductRelations, deleteProductRelation, getProductRelations } from '../../controllers/admin/productController.js';
import {
  getCustomers,
  getInquiries, markContacted, deleteInquiry,
  getAdminTestimonials, approveTestimonial, rejectTestimonial, deleteTestimonial,
} from '../../controllers/admin/adminMiscController.js';
import adminAuth from '../../middleware/adminAuth.js';
import { upload } from '../../config/cloudinary.js';

import { updateInquiryStatus } from '../../controllers/contactController.js';

const router = Router();

// ── Login (no auth, strict rate limit) ───────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: 'Too many admin login attempts. Try again in 15 minutes.' },
});
router.post('/login', loginLimiter, adminLogin);
router.post('/logout', adminLogout);

// ── All routes below require admin token ──────────────────────────────────────
router.use(adminAuth);
router.get('/me', adminMe);

// Dashboard
router.get('/dashboard', getDashboardStats);

// Orders
router.get('/orders',               getOrders);
router.get('/orders/:id',           getOrder);
router.patch('/orders/bulk-status', bulkUpdateStatus);   // Must be before /:id route
router.patch('/orders/:id/status',  updateOrderStatus);

// Products
router.get   ('/products',     getProducts);
router.post  ('/products',     upload.single('image'), createProduct);
router.put   ('/products/:id', upload.single('image'), updateProduct);
router.delete('/products/:id', deleteProduct);
router.get   ('/products/:id/relations', getProductRelations);
// Product relations management
router.post  ('/products/:id/relations', setProductRelations);
router.delete('/products/:id/relations/:relId', deleteProductRelation);

// Customers
router.get('/customers', getCustomers);

// Inquiries
router.get   ('/inquiries',              getInquiries);
router.patch ('/inquiries/:id/contacted',markContacted);
router.delete('/inquiries/:id',          deleteInquiry);
router.patch('/inquiries/:id', updateInquiryStatus);

// Testimonials
router.get   ('/testimonials',            getAdminTestimonials);
router.patch ('/testimonials/:id/approve',approveTestimonial);
router.patch ('/testimonials/:id/reject', rejectTestimonial);
router.delete('/testimonials/:id',        deleteTestimonial);


export default router;
