import {
  getApprovedTestimonials,
  createTestimonial,
} from '../services/testimonialService.js';
import cache from '../utils/cache.js';

const TESTIMONIALS_TTL = 600; // 10 minutes

// GET /api/testimonials — approved only, public
export const getTestimonials = async (req, res) => {
  try {
    const cacheKey = 'testimonials:approved';
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const rows = await getApprovedTestimonials();
    cache.set(cacheKey, rows, TESTIMONIALS_TTL);
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching testimonials', err);
    return res.status(500).json({ message: 'Unable to fetch testimonials' });
  }
};

// POST /api/testimonials — user submits; goes to moderation queue
export const submitTestimonial = async (req, res) => {
  try {
    const { name, role, text, rating = 5 } = req.body;
    const userId = req.user?.id || null;

    if (!name?.trim() || !text?.trim()) {
      return res.status(400).json({ message: 'Name and review text are required.' });
    }

    const normalizedRating = parseInt(rating, 10);
    if (Number.isNaN(normalizedRating) || normalizedRating < 1 || normalizedRating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
    }

    const created = await createTestimonial({
      userId,
      name: name.trim(),
      role: role?.trim() || null,
      text: text.trim(),
      rating: normalizedRating,
    });

    if (!created) {
      return res.status(409).json({ message: 'Duplicate testimonial detected.' });
    }

    return res.status(201).json({ message: 'Thank you! Your review has been submitted for moderation.' });
  } catch (err) {
    console.error('Error submitting testimonial', err);
    return res.status(500).json({ message: 'Unable to submit testimonial' });
  }
};
