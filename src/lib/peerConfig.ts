import type { PeerJSOption } from 'peerjs'

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) {
    return undefined
  }

  return !['false', '0', 'no'].includes(value.toLowerCase())
}

const parsePort = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const parseIceServers = (value: string): RTCIceServer[] | undefined => {
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed)) {
      return parsed as RTCIceServer[]
    }
  } catch {
    // fall back to comma separated list
  }

  const servers = value
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }))

  return servers.length > 0 ? servers : undefined
}

export const createPeerOptions = (): PeerJSOption => {
  const host = import.meta.env.VITE_PEERJS_HOST?.trim()
  const secure = parseBoolean(import.meta.env.VITE_PEERJS_SECURE)
  const port = parsePort(import.meta.env.VITE_PEERJS_PORT)
  const path = import.meta.env.VITE_PEERJS_PATH?.trim()
  const turnUrl = import.meta.env.VITE_TURN_URL?.trim()
  const customIceServers = import.meta.env.VITE_PEERJS_ICE_SERVERS?.trim()

  const options: PeerJSOption = {
    debug: 2
  }

  if (host) {
    options.host = host
  }

  if (secure !== undefined) {
    options.secure = secure
  }

  if (port !== undefined) {
    options.port = port
  }

  if (path) {
    options.path = path
  }

  let iceServers: RTCIceServer[] | undefined

  if (customIceServers) {
    iceServers = parseIceServers(customIceServers)
  }

  if (turnUrl) {
    iceServers = iceServers ?? []
    iceServers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL
    })
  }

  if (iceServers?.length) {
    options.config = { iceServers }
  }

  return options
}
