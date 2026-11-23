'use strict';

const path = require('node:path');

function postgresTool(name) {
    const binDir = process.env.PG_BINDIR;
    if (!binDir) return name;
    const executable = process.platform === 'win32' ? `${name}.exe` : name;
    return path.join(binDir, executable);
}

function backupDatabaseUrl(explicitUrl) {
    if (explicitUrl !== undefined) return explicitUrl;
    const direct = process.env.DATABASE_URL_UNPOOLED;
    const primary = process.env.DATABASE_URL;
    if (!direct || !primary) {
        const selected = direct || primary;
        if (selected && /^postgres(?:ql)?:\/\//i.test(selected)) {
            const url = new URL(selected);
            if (url.hostname.endsWith('.neon.tech') && /^[^.]+-pooler\./.test(url.hostname)) {
                throw new Error('A direct Neon connection is required for backup and restore.');
            }
        }
        return selected;
    }

    try {
        const a = new URL(primary);
        const b = new URL(direct);
        const forbidden = ['host', 'hostaddr', 'port', 'user', 'dbname', 'service', 'options'];
        const valid = url => ['postgres:', 'postgresql:'].includes(url.protocol)
            && url.hostname && url.username && url.pathname.length > 1
            && !Array.from(url.searchParams.keys()).some(key => forbidden.includes(key.toLowerCase()));
        if (!valid(a) || !valid(b)) throw new Error();
        const neon = host => host.endsWith('.neon.tech');
        const directHost = b.hostname;
        const pooledHost = neon(a.hostname) && neon(directHost)
            ? a.hostname.replace(/^([^.]+)-pooler\./, '$1.')
            : a.hostname;
        if (pooledHost !== directHost
            || (a.port || '5432') !== (b.port || '5432')
            || decodeURIComponent(a.username) !== decodeURIComponent(b.username)
            || decodeURIComponent(a.pathname) !== decodeURIComponent(b.pathname)
            || (neon(directHost) && /^[^.]+-pooler\./.test(directHost))) {
            throw new Error();
        }
    } catch {
        throw new Error('DATABASE_URL_UNPOOLED does not match DATABASE_URL; backup or restore was not started.');
    }
    return direct;
}

module.exports = { backupDatabaseUrl, postgresTool };
