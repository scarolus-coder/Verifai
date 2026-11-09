'use strict';

const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');

const client = new SESClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const FROM = process.env.SES_FROM_EMAIL || 'no-reply@fayze2.com';

/**
 * Send an email via Amazon SES.
 * @param {object} opts
 * @param {string|string[]} opts.to      Recipient address(es)
 * @param {string}          opts.subject Subject line
 * @param {string}          opts.text    Plain-text body
 * @param {string}          [opts.html]  Optional HTML body
 * @returns {Promise<string>} SES message ID
 */
async function sendEmail({ to, subject, text, html }) {
  const toAddresses = Array.isArray(to) ? to : [to];

  const command = new SendEmailCommand({
    Source: FROM,
    Destination: { ToAddresses: toAddresses },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: text, Charset: 'UTF-8' },
        ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
      },
    },
  });

  const result = await client.send(command);
  return result.MessageId;
}

module.exports = { sendEmail };
