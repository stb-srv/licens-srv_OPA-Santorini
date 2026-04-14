/**
 * server/mailer/templates.js
 * HTML-E-Mail-Templates für den OPA! Santorini Lizenzserver.
 */

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
          <tr>
            <td style="background:linear-gradient(135deg,#6c63ff 0%,#5a52d5 100%);border-radius:12px 12px 0 0;padding:28px 32px">
              <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;letter-spacing:-0.3px">
                &#9889; OPA! Santorini Lizenzserver
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background:#fff;padding:32px;border-left:1px solid #e8e8f0;border-right:1px solid #e8e8f0">
              ${bodyHtml}
            </td>
          </tr>
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

const TEMPLATES = {

    test: (d) => ({
        subject: 'OPA! Santorini \u2014 SMTP Test \u2705',
        html: layout('SMTP Test', `
          <h2 style="margin:0 0 12px;font-size:18px;color:#222">SMTP-Test erfolgreich &#9989;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Diese E-Mail best\u00e4tigt, dass deine SMTP-Konfiguration korrekt eingerichtet ist.
          </p>
          ${infoBox([
            ['Gesendet am', new Date().toLocaleString('de-DE')],
            ['SMTP-Server', d.host || 'konfiguriert']
          ])}
        `),
        text: `OPA! Santorini Lizenzserver — SMTP Test erfolgreich.\n\nGesendet: ${new Date().toLocaleString('de-DE')}`
    }),

    // Neuer Kunde angelegt — sendet Login-Daten mit temporärem Passwort
    accountCreated: (d) => ({
        subject: 'Deine Zugangsdaten f\u00fcr OPA! Santorini',
        html: layout('Account erstellt', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Willkommen, ${d.name || 'Kunde'}! &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Dein Zugang zum <strong>OPA! Santorini Kunden-Portal</strong> wurde angelegt.
            Dort kannst du deine Lizenzen einsehen, Domains verwalten und deine Kaufhistorie abrufen.
          </p>
          ${infoBox([
            ['Benutzername', `<code style="background:#e8f4fd;padding:3px 8px;border-radius:4px;font-size:14px;font-weight:700;color:#0369a1">${d.username || d.email}</code>`],
            ['E-Mail', d.email],
            ['Tempor\u00e4res Passwort', `<code style="background:#fff3cd;padding:3px 8px;border-radius:4px;font-size:14px;font-weight:700;color:#856404">${d.password}</code>`],
            ['Portal-URL', `<a href="${d.login_url}" style="color:#6c63ff">${d.login_url}</a>`]
          ])}
          <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:14px 18px;margin:20px 0">
            <p style="margin:0;color:#856404;font-size:13px;line-height:1.6">
              \u26a0\ufe0f <strong>Wichtig:</strong> Bitte \u00e4ndere dein Passwort direkt nach dem ersten Login.
              Du wirst automatisch dazu aufgefordert.
            </p>
          </div>
          <div style="text-align:center;margin:28px 0">
            <a href="${d.login_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              &#128272; Jetzt einloggen
            </a>
          </div>
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Fragen? Schreib uns an support@stb-srv.de
          </p>
        `),
        text: `Willkommen beim OPA! Santorini Kunden-Portal\n\nDeine Zugangsdaten:\nBenutzername: ${d.username || d.email}\nE-Mail: ${d.email}\nPasswort: ${d.password}\n\nPortal: ${d.login_url}\n\nBitte \u00e4ndere dein Passwort nach dem ersten Login.`
    }),

    portalInvite: (d) => ({
        subject: 'Einladung zum OPA! Santorini Kunden-Portal',
        html: layout('Portal-Einladung', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Willkommen im Kunden-Portal &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.name || 'Kunde'},<br><br>
            du wurdest eingeladen, auf das <strong>OPA! Santorini Kunden-Portal</strong> zuzugreifen.
            Dort kannst du deine Lizenzen einsehen, Domains binden und deine Kaufhistorie abrufen.
          </p>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Klicke auf den folgenden Button, um ein Passwort zu setzen und dein Konto zu aktivieren.
            Der Link ist <strong>24 Stunden gültig</strong>.
          </p>
          <div style="text-align:center;margin:28px 0">
            <a href="${d.invite_url}" style="display:inline-block;background:#6c63ff;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px">
              &#128272; Passwort setzen &amp; einloggen
            </a>
          </div>
          ${infoBox([
            ['E-Mail', d.email],
            ['Link gültig bis', new Date(Date.now() + 24*60*60*1000).toLocaleString('de-DE')]
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Falls du diese Einladung nicht erwartet hast, ignoriere diese E-Mail.
          </p>
        `),
        text: `Einladung zum OPA! Santorini Kunden-Portal\n\nHallo ${d.name},\n\nHier ist dein Einladungslink:\n${d.invite_url}\n\nDer Link ist 24 Stunden gültig.`
    }),

    licenseCreated: (d) => ({
        subject: `Deine OPA! Santorini Lizenz ist bereit`,
        html: layout('Lizenz erstellt', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#222">Deine Lizenz ist aktiv &#127881;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz f\u00fcr <strong>OPA! Santorini</strong> wurde erfolgreich erstellt und ist sofort einsatzbereit.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Plan', badge(d.type || 'FREE')],
            ['G\u00fcltig bis', d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'Unbegrenzt'],
            ['Domain', d.associated_domain || '*']
          ])}
          <p style="margin:20px 0 0;color:#aaa;font-size:13px">
            Du kannst deine Lizenz jederzeit im Kunden-Portal einsehen.
          </p>
        `),
        text: `Lizenz erstellt\n\nLizenzschlüssel: ${d.license_key}\nPlan: ${d.type}\nGültig bis: ${d.expires_at}`
    }),

    licenseExpiringSoon: (d) => ({
        subject: `Deine OPA! Santorini Lizenz läuft in ${d.days_left || '?'} Tagen ab`,
        html: layout('Lizenz läuft ab', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e67e22">&#9888;&#65039; Lizenz l\u00e4uft bald ab</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz l\u00e4uft in <strong>${d.days_left} Tagen</strong> ab.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Plan', badge(d.type || 'FREE', '#e67e22')],
            ['L\u00e4uft ab am', d.expires_at ? new Date(d.expires_at).toLocaleDateString('de-DE') : 'unbekannt']
          ])}
        `),
        text: `Lizenz läuft bald ab\n\nDeine Lizenz läuft in ${d.days_left} Tagen ab.\nLizenzschlüssel: ${d.license_key}`
    }),

    licenseRenewed: (d) => ({
        subject: 'OPA! Santorini \u2014 Lizenz erfolgreich verlängert',
        html: layout('Lizenz verlängert', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#27ae60">Lizenz verl\u00e4ngert &#10003;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz wurde erfolgreich verlängert.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Plan', badge(d.type || 'FREE', '#27ae60')],
            ['Neues Ablaufdatum', d.new_expires_at ? new Date(d.new_expires_at).toLocaleDateString('de-DE') : 'Unbegrenzt'],
            ['Verlängert um', `${d.days} Tage`]
          ])}
        `),
        text: `Lizenz verlängert\n\nNeues Ablaufdatum: ${d.new_expires_at}`
    }),

    licenseRevoked: (d) => ({
        subject: 'OPA! Santorini \u2014 Lizenz widerrufen',
        html: layout('Lizenz widerrufen', `
          <h2 style="margin:0 0 8px;font-size:18px;color:#e74c3c">Lizenz widerrufen &#10060;</h2>
          <p style="margin:0 0 20px;color:#555;line-height:1.7">
            Hallo ${d.customer_name || 'Kunde'},<br><br>
            deine Lizenz wurde widerrufen. Bitte wende dich an den Administrator.
          </p>
          ${infoBox([
            ['Lizenzschl\u00fcssel', `<code style="background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px">${d.license_key}</code>`],
            ['Grund', d.reason || 'Nicht angegeben']
          ])}
        `),
        text: `Lizenz widerrufen\n\nLizenzschlüssel: ${d.license_key}\nGrund: ${d.reason || 'Nicht angegeben'}`
    })
};

export function renderTemplate(name, data = {}) {
    const tpl = TEMPLATES[name];
    if (!tpl) throw new Error(`Template '${name}' nicht gefunden. Verfügbar: ${Object.keys(TEMPLATES).join(', ')}`);
    return tpl(data);
}

export { TEMPLATES };
