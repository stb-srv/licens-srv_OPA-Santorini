/**
 * server/mailer/templates.js
 * HTML-E-Mail-Templates für den OPA! Santorini Lizenzserver.
 * Jedes Template gibt { subject, html, text } zurück.
 */

// ── Basis-Layout ───────────────────────────────────────────────────────────
function layout(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f2f5;padding:32px 0">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#6c63ff 0%,#5a52d5 100%);border-radius:12px 12px 0 0;padding:28px 32px">
              <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px">
                &#9889; OPA! Santorini Lizenzserver
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#fff;padding:32px;border-left:1px solid #e8e8f0;border-right:1px solid #e8e8f0">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8f8fc;border:1px solid #e8e8f0;border-top:none;border-radius:0 0 12px 12px;padding:18px 32px;text-align:center">
              <p style="margin:0;color:#aaa;font-size:12px">
                OPA! Santorini Lizenzserver &nbsp;&bull;&nbsp; Automatisch generierte E-Mail
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Hilfsfunktionen ────────────────────────────────────────────────────────
function badge(text, color = '#6c63ff') {
    return `<span style="display:inline-block;background:${color};color:#fff;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600">${text}</span>`;
}

function infoBox(rows) {
    const cells = rows.map(([label, value]) =>
        `<tr>
          <td style="padding:8px 0;color:#888;font-size:13px;width:140px;vertical-align:top">${label}</td>
          <td style="padding:8px 0;color:#222;font-size:13px;font-weight:500">${value}</td>
        </tr>`
    ).join('');
    return `<table width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:#f8f8fc;border-radius:8px;padding:16px 20px;margin:20px 0">
      ${cells}
    </table>`;
}

// ── Templates ──────────────────────────────────────────────────────────────

const TEMPLATES = {

    // ── Test-Mail ────────────────────────────────────────────────────────
    test: (d) => ({
        subject: 'OPA! Santorini \u2014 SMTP Test \u2705',
        html: layout('SMTP Test', `
          <h2 style="margin:0 0 12px;font-size:18px;color:#222">SMTP-Test erfolgreich &#9989;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Diese E-Mail best\u00e4tigt, dass deine SMTP-Konfiguration korrekt eingerichtet ist
            und E-Mails erfolgreich zugestellt werden k\u00f6nnen.
          </p>
          ${infoBox([
            ['Gesendet am', new Date().toLocaleString('de-DE')],
            ['SMTP-Server', d.host || 'aus Datenbank / .env']
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Falls du diese E-Mail nicht erwartet hast, kannst du sie ignorieren.
          </p>
        `),
        text: `OPA! Santorini Lizenzserver — SMTP Test erfolgreich.\n\nDiese E-Mail bestätigt, dass deine SMTP-Konfiguration korrekt funktioniert.\n\nGesendet: ${new Date().toLocaleString('de-DE')}`
    }),

    // ── Lizenz erstellt ──────────────────────────────────────────────────
    licenseCreated: (d) => ({
        subject: `Deine OPA! Santorini Lizenz ist bereit`,
        html: layout('Lizenz erstellt', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Willkommen, ${d.customer_name || 'Kunde'}! &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Deine Lizenz f\u00fcr <strong>OPA! Santorini</strong> wurde erfolgreich erstellt.
            Hier sind deine Lizenzdetails:
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Plan', badge(d.type || 'FREE')],
            ['G\u00fcltig bis', d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'Unbegrenzt'],
            ['Domain', d.associated_domain || '*']
          ])}
          <p style="margin:20px 0 0;color:#555;line-height:1.7">
            Trage den Lizenzschl\u00fcssel in deinem OPA! Santorini System ein, um alle Funktionen freizuschalten.
          </p>
        `),
        text: `Lizenz erstellt\n\nHallo ${d.customer_name || 'Kunde'},\n\nDeine Lizenz wurde erstellt.\n\nLizenzschlüssel: ${d.license_key}\nPlan: ${d.type || 'FREE'}\nGültig bis: ${d.expires_at || 'Unbegrenzt'}\n\nOPA! Santorini Lizenzserver`
    }),

    // ── Lizenz läuft bald ab ─────────────────────────────────────────────
    licenseExpiringSoon: (d) => ({
        subject: `Deine OPA! Santorini Lizenz l\u00e4uft in ${d.days_left || '?'} Tagen ab`,
        html: layout('Lizenz l\u00e4uft ab', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e67e22">&#9888;&#65039; Lizenz l\u00e4uft bald ab</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz f\u00fcr <strong>OPA! Santorini</strong> l\u00e4uft in
            <strong>${d.days_left} Tagen</strong> ab. Bitte verl\u00e4ngere sie rechtzeitig,
            um Unterbrechungen zu vermeiden.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Plan', badge(d.type || 'FREE', '#e67e22')],
            ['L\u00e4uft ab am', d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'unbekannt']
          ])}
          <p style="margin:20px 0 0;color:#555;line-height:1.7">
            Wende dich an deinen Administrator, um die Lizenz zu verl\u00e4ngern.
          </p>
        `),
        text: `Lizenz läuft bald ab\n\nHallo ${d.customer_name || 'Kunde'},\n\ndeine Lizenz läuft in ${d.days_left} Tagen ab.\n\nLizenzschlüssel: ${d.license_key}\nAbläuft am: ${d.expires_at}\n\nOPA! Santorini Lizenzserver`
    }),

    // ── Lizenz verlängert ────────────────────────────────────────────────
    licenseRenewed: (d) => ({
        subject: 'OPA! Santorini \u2014 Lizenz erfolgreich verl\u00e4ngert',
        html: layout('Lizenz verlängert', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#27ae60">Lizenz verl\u00e4ngert &#10003;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz wurde erfolgreich verl\u00e4ngert.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Plan', badge(d.type || 'FREE', '#27ae60')],
            ['Neues Ablaufdatum', d.new_expires_at ? new Date(d.new_expires_at).toLocaleDateString('de-DE') : 'Unbegrenzt'],
            ['Verl\u00e4ngert um', `${d.days} Tage`]
          ])}
        `),
        text: `Lizenz verlängert\n\nHallo ${d.customer_name || 'Kunde'},\n\ndeine Lizenz wurde verlängert.\n\nLizenzschlüssel: ${d.license_key}\nNeues Ablaufdatum: ${d.new_expires_at}\n\nOPA! Santorini Lizenzserver`
    }),

    // ── Lizenz widerrufen ────────────────────────────────────────────────
    licenseRevoked: (d) => ({
        subject: 'OPA! Santorini \u2014 Lizenz widerrufen',
        html: layout('Lizenz widerrufen', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e74c3c">Lizenz widerrufen &#10060;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz f\u00fcr <strong>OPA! Santorini</strong> wurde widerrufen.
            Wende dich an den Administrator f\u00fcr weitere Informationen.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Grund', d.reason || 'Nicht angegeben']
          ])}
        `),
        text: `Lizenz widerrufen\n\nHallo ${d.customer_name || 'Kunde'},\n\ndeine Lizenz wurde widerrufen.\n\nLizenzschlüssel: ${d.license_key}\nGrund: ${d.reason || 'Nicht angegeben'}\n\nOPA! Santorini Lizenzserver`
    })
};

// ── Renderer ──────────────────────────────────────────────────────────────
export function renderTemplate(name, data = {}) {
    const tpl = TEMPLATES[name];
    if (!tpl) throw new Error(`E-Mail-Template '${name}' nicht gefunden. Verfügbar: ${Object.keys(TEMPLATES).join(', ')}`);
    return tpl(data);
}

export { TEMPLATES };
