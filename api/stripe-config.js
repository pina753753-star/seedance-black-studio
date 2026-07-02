'use strict';
module.exports = function handler(req, res) {
  res.status(200).json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '' });
};
