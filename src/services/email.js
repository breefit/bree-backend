import nodemailer from 'nodemailer';

const createTransporter = () =>
  nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

export const sendOrderConfirmation = async ({ to, name, orderId, amount, items }) => {
  if (!process.env.SMTP_USER) return; // Skip if not configured

  const itemRows = items
    .map((i) => `<tr><td>${i.name}</td><td>${i.quantity}</td><td>₹${i.price}</td></tr>`)
    .join('');

  await createTransporter().sendMail({
    from:    `"BREE Wellness" <${process.env.SMTP_USER}>`,
    to,
    subject: `Order Confirmed — BREE #${orderId.slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
        <h2 style="color:#2d6a4f;">Hi ${name}, your order is confirmed! 🎉</h2>
        <p>Order ID: <strong>#${orderId.slice(-8).toUpperCase()}</strong></p>
        <table width="100%" cellpadding="8" style="border-collapse:collapse;">
          <thead><tr style="background:#f0f0f0">
            <th align="left">Product</th><th>Qty</th><th>Price</th>
          </tr></thead>
          <tbody>${itemRows}</tbody>
          <tfoot><tr>
            <td colspan="2"><strong>Total</strong></td>
            <td><strong>₹${amount}</strong></td>
          </tr></tfoot>
        </table>
        <p style="color:#888;font-size:12px;">The BREE Team</p>
      </div>
    `,
  });
};

export const sendContactAck = async ({ to, name }) => {
  if (!process.env.SMTP_USER) return;
  await createTransporter().sendMail({
    from:    `"BREE Wellness" <${process.env.SMTP_USER}>`,
    to,
    subject: 'We received your message — BREE',
    html: `<p>Hi ${name},<br>Thanks for reaching out! We'll get back to you within 24 hours.<br><br>— The BREE Team</p>`,
  });
};
