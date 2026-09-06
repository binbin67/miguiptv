function toWords(bytes, includeLength) {
  const size = Math.ceil(bytes.length / 4)
  const words = new Uint32Array(includeLength ? size + 1 : size)
  for (let index = 0; index < bytes.length; index++) {
    words[index >>> 2] |= bytes[index] << ((index & 3) << 3)
  }
  if (includeLength) words[size] = bytes.length
  return words
}

function toBytes(words, includeLength) {
  let size = words.length << 2
  if (includeLength) {
    const expected = words[words.length - 1]
    size -= 4
    if (expected < size - 3 || expected > size) throw new Error('内蒙古广电接口数据解密失败')
    size = expected
  }
  const bytes = new Uint8Array(size)
  for (let index = 0; index < size; index++) {
    bytes[index] = words[index >>> 2] >>> ((index & 3) << 3)
  }
  return bytes
}

export function encrypt(data, key) {
  if (!data.length) return data
  const words = toWords(data, true)
  const shortKey = toWords(key, false)
  const paddedKey = new Uint32Array(4)
  paddedKey.set(shortKey.subarray(0, 4))
  const last = words.length - 1
  let y = words[0]
  let z = words[last]
  const delta = 0x9e3779b9
  let sum = 0
  let rounds = Math.floor(6 + 52 / words.length)

  while (rounds-- > 0) {
    sum = (sum + delta) >>> 0
    const e = (sum >>> 2) & 3
    for (let position = 0; position < last; position++) {
      y = words[position + 1]
      const mix = (((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4)) ^
        ((sum ^ y) + (paddedKey[(position & 3) ^ e] ^ z))) >>> 0
      z = words[position] = (words[position] + mix) >>> 0
    }
    y = words[0]
    const mix = (((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4)) ^
      ((sum ^ y) + (paddedKey[(last & 3) ^ e] ^ z))) >>> 0
    z = words[last] = (words[last] + mix) >>> 0
  }
  return toBytes(words, false)
}

export function decrypt(data, key) {
  if (!data.length) return data
  const words = toWords(data, false)
  const shortKey = toWords(key, false)
  const paddedKey = new Uint32Array(4)
  paddedKey.set(shortKey.subarray(0, 4))
  const last = words.length - 1
  let y = words[0]
  let z = words[last]
  const delta = 0x9e3779b9
  let sum = Math.imul(Math.floor(6 + 52 / words.length), delta) >>> 0

  while (sum !== 0) {
    const e = (sum >>> 2) & 3
    for (let position = last; position > 0; position--) {
      z = words[position - 1]
      const mix = (((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4)) ^
        ((sum ^ y) + (paddedKey[(position & 3) ^ e] ^ z))) >>> 0
      y = words[position] = (words[position] - mix) >>> 0
    }
    z = words[last]
    const mix = (((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4)) ^
      ((sum ^ y) + (paddedKey[e] ^ z))) >>> 0
    y = words[0] = (words[0] - mix) >>> 0
    sum = (sum - delta) >>> 0
  }
  return toBytes(words, true)
}

export function decryptBase64(value, key) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('内蒙古广电接口没有返回有效密文')
  }
  const clear = decrypt(Buffer.from(value, 'base64'), Buffer.from(key))
  return new TextDecoder('utf-8', { fatal: true }).decode(clear)
}

export function encryptBase64(value, key) {
  return Buffer.from(encrypt(Buffer.from(value), Buffer.from(key))).toString('base64')
}
