// The e-mail services reached over HTTPS (documentation 2.8): one fixed address each, only POST, the key only in a
// header. The network policy (11.2) lets exactly these addresses through, in both network modes.
export const mailApis = {
  brevo: {
    name: 'Brevo',
    url: 'https://api.brevo.com/v3/smtp/email',
    headers: (key) => ({ 'api-key': key }),
    body: (from, mail) => ({
      sender: { email: from },
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.text,
      ...(mail.replyTo ? { replyTo: { email: mail.replyTo } } : {}),
    }),
  },
  resend: {
    name: 'Resend',
    url: 'https://api.resend.com/emails',
    headers: (key) => ({ Authorization: 'Bearer ' + key }),
    body: (from, mail) => ({
      from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
  },
};
export const mailApiUrls = Object.values(mailApis).map((api) => api.url);
