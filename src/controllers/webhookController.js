// StaffArc — Shiprocket / Logistics Webhook Handler
// Prepared by: Swaroop | staffarc.in

router.post('/webhooks/logistics', async (req, res) => {
  const { awb, current_status, shipment_id, order_id } = req.body;

  console.log(`Logistics event: ${current_status} for order ${order_id}`);

  switch (current_status) {

    case 'Picked Up':
      await Order.updateStatus(order_id, 'SHIPPED');
      await Notification.send(order_id, {
        message: `Your order has been picked up! Track: ${awb}`,
        channels: ['sms', 'whatsapp']
      });
      break;

    case 'Out For Delivery':
      await Notification.send(order_id, {
        message: '🚴 Arriving today! Please be available.',
        channels: ['sms', 'whatsapp', 'push']
      });
      break;

    case 'Delivered':
      await Order.updateStatus(order_id, 'DELIVERED');
      await Notification.send(order_id, {
        message: '✅ Delivered! Leave a review and earn loyalty points!',
        channels: ['email', 'whatsapp']
      });
      await Analytics.track('order_delivered', { order_id, awb });
      break;

    case 'RTO Initiated':
      await Order.updateStatus(order_id, 'RTO_INITIATED');
      await OpsTeam.alert({ order_id, reason: 'Delivery failed' });
      break;
  }

  res.status(200).json({ received: true });
});