import pump from 'pump'
import MeterStream from 'meterstream'
import { Writable, Readable, PassThrough } from 'stream'
import initDebug from 'debug'
import { KeyNotFound, UploadNotFound, OffsetMismatch, UploadLocked } from './errors'

const debug = initDebug('abstract-tus-store')

export default () => {
  const map = new Map()
  const keyMap = new Map()

  let uploadIdCounter = 0

  const create = async (key, { uploadLength, metadata } = {}) => {
    const uploadId = `${uploadIdCounter}`
    map.set(uploadId, {
      info: { key, uploadLength, metadata },
      data: new Buffer([]),
    })
    uploadIdCounter += 1
    return { uploadId }
  }

  const info = async uploadId => {
    if (!map.has(uploadId)) throw new UploadNotFound(uploadId)
    const upload = map.get(`${uploadId}`)
    const offset = upload.data.length
    if (upload.info.uploadLength === offset && !keyMap.has(upload.info.key)) {
      // for some reason upload did not complete, force a last append...
      return { offset: offset - 1, ...upload.info }
    }
    return { offset, ...upload.info }
  }

  const createLimitStream = (uploadLength, offset) => {
    if (typeof uploadLength === 'undefined') return new PassThrough()
    const meterStream = new MeterStream(uploadLength - offset)
    return meterStream
  }

  const completeUpload = async (upload, uploadId, beforeComplete) => {
    debug('completing upload')
    await beforeComplete(upload.info, uploadId)
    keyMap.set(upload.info.key, {
      data: upload.data,
      metadata: upload.info.metadata,
    })
    return {
      offset: upload.data.length,
      upload: await info(uploadId),
    }
  }

  const append = async (uploadId, rs, arg3, arg4) => {
    const {
      expectedOffset,
      opts: {
        beforeComplete = async () => {},
      },
    } = (() => {
      if (typeof arg3 === 'object') {
        return { opts: arg3 || {} }
      }
      return { expectedOffset: arg3, opts: arg4 || {} }
    })()
    // "block" data before doing any async stuff
    const through = rs.pipe(new PassThrough())

    if (!map.has(uploadId)) throw new UploadNotFound(uploadId)
    const upload = map.get(uploadId)
    const oldOffset = upload.data.length
    if (oldOffset === upload.info.uploadLength) {
      // for some reason, upload is finished but was not completed
      if (!Number.isInteger(expectedOffset) || expectedOffset === upload.info.uploadLength - 1) {
        return completeUpload(upload, uploadId, beforeComplete)
      }
    }
    if (Number.isInteger(expectedOffset)) {
      // check if offset is right
      if (oldOffset !== expectedOffset) {
        throw new OffsetMismatch(oldOffset, expectedOffset)
      }
    }

    // TODO: lock upload?
    if (upload.locked) throw new UploadLocked()
    try {
      upload.locked = true
      const newChunks = []
      const ws = new Writable({
        write(chunk, encoding, cb) {
          newChunks.push(chunk)
          cb()
        },
      })

      const limitStream = createLimitStream(upload.info.uploadLength, oldOffset)

      await new Promise((resolve, reject) => {
        // TODO: make sure we "block" through stream so that uploadLength is
        // not exceeded
        pump(through, limitStream, ws, (err) => {
          // should try to write as many bytes as possible even if error
          upload.data = Buffer.concat([upload.data, ...newChunks])
          if (err) return reject(err)
          resolve(upload.data)
        })
      })

      if (upload.data.length === upload.info.uploadLength) {
        // complete upload
        return completeUpload(upload, uploadId, beforeComplete)
      }
      return {
        offset: upload.data.length,
        upload: await info(uploadId),
      }
    } finally {
      upload.locked = false
    }
  }

  const createReadStream = (key, onInfo) => {
    if (onInfo) {
      process.nextTick(() => {
        if (keyMap.has(key)) {
          const keyInfo = keyMap.get(key)
          onInfo({
            contentLength: keyInfo.data.length,
            metadata: keyInfo.metadata || {},
          })
        }
      })
    }
    return new Readable({
      read() {
        if (!keyMap.has(key)) {
          this.emit('error', new KeyNotFound(key))
        }
        this.push(keyMap.get(key).data)
        this.push(null)
      },
    })
  }

  return {
    info,
    create,
    append,
    createReadStream,
  }
}
