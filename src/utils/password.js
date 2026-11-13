import { randomInt } from "node:crypto";

// no 0/O, 1/l/I so a password read out loud or typed from a screen isn't misread
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random one-time password for a new or reset user, e.g. "pK7mWq3zXe9N" */
export const temporaryPassword = (length = 12) => Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
