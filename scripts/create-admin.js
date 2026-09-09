#!/usr/bin/env node
// Crea (o reestablece) el usuario administrador del panel.
//   npm run create-admin -- --user admin
//   npm run create-admin -- --user admin --pass "mi contrasena larga"
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../src/lib/db.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomPassword = (n = 16) =>
  Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');

const username = String(arg('user', 'admin')).toLowerCase();
const password = arg('pass') || randomPassword();
const generated = !arg('pass');

if (password.length < 10) {
  console.error('La contrasena debe tener al menos 10 caracteres.');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  db.prepare(
    `UPDATE users SET password_hash = ?, role = 'admin', active = 1,
            must_change_password = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(hash, generated ? 1 : 0, existing.id);
  console.log(`Administrador actualizado: ${username}`);
} else {
  db.prepare(
    `INSERT INTO users (username, password_hash, role, display_name, must_change_password)
     VALUES (?, ?, 'admin', 'Administrador', ?)`
  ).run(username, hash, generated ? 1 : 0);
  console.log(`Administrador creado: ${username}`);
}

if (generated) console.log(`Contrasena: ${password}`);
console.log('Guardala en un sitio seguro: no se vuelve a mostrar.');
db.close();
