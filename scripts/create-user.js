#!/usr/bin/env node
// Crea un usuario normal desde la linea de comandos.
//   npm run create-user -- --user juan --name "Juan Perez" --fee 10
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db from '../src/lib/db.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const username = String(arg('user', '')).toLowerCase();
const displayName = arg('name');
const feePct = Math.min(Math.max(Number.parseFloat(arg('fee', '0')) || 0, 0), 100);
const password = arg('pass') || Array.from(crypto.randomBytes(14), (b) => ALPHABET[b % ALPHABET.length]).join('');

if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
  console.error('Uso: npm run create-user -- --user <nombre> [--name "Nombre"] [--fee 10] [--pass ...]');
  process.exit(1);
}
if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
  console.error(`El usuario "${username}" ya existe.`);
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);
db.prepare(
  `INSERT INTO users (username, password_hash, role, display_name, fee_pct, must_change_password)
   VALUES (?, ?, 'user', ?, ?, 1)`
).run(username, hash, displayName, feePct);

console.log(`Usuario creado: ${username}`);
console.log(`Contrasena provisional: ${password}`);
console.log('Se le pedira cambiarla al entrar por primera vez.');
db.close();
