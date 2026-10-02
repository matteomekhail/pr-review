// Computes the next release version from the latest v* tag and writes it into tauri.conf.json and Cargo.toml.
import { readFileSync, writeFileSync } from 'node:fs';

const latest = (await Bun.$`git tag --list 'v*' --sort=-v:refname`.quiet().text()).split('\n').find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { version: string };
const [baseMajor, baseMinor] = config.version.split('.').map(Number);
const [major, minor, patch] = (latest?.slice(1) ?? `${baseMajor}.${baseMinor}.0`).split('.').map(Number);
const next = major === baseMajor && minor === baseMinor ? `${major}.${minor}.${(patch ?? 0) + (latest == null ? 0 : 1)}` : `${baseMajor}.${baseMinor}.0`;

config.version = next;
writeFileSync('src-tauri/tauri.conf.json', `${JSON.stringify(config, null, 2)}\n`);
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').replace(/^version = "[^"]+"/m, `version = "${next}"`);
writeFileSync('src-tauri/Cargo.toml', cargo);
console.log(next);
