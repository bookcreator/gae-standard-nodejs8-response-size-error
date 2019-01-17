const HttpError = require('http-errors')
const etag = require('etag')

module.exports = (req, res, next) => {
   if (!req.gcsFile || typeof req.gcsFile !== 'object') return next(new HttpError.InternalServerError('No file'))
   if (!req.gcsFile.metadata || typeof req.gcsFile.metadata !== 'object') {
      req.gcsFile.metadata = {}
   }

   const contentType = req.gcsFile.metadata.contentType
   const contentLength = req.gcsFile.metadata.size
   const lastModified = (updated => {
      if (!updated) return null
      const d = new Date(updated)
      // Round down as HTTP dates don't support ms
      return new Date(Math.floor(d.getTime() / 1000) * 1000)
   })(req.gcsFile.metadata.updated)
   let eTag = (et => { return et ? etag(et) : null })(req.gcsFile.metadata.etag)

   if (contentLength === 0 || contentLength === '0') {
      const err = new HttpError.InternalServerError('File has 0 bytes size')
      err.gcsFile = req.gcsFile.name
      return next(err)
   }

   // Setup response
   res.set('Accept-Ranges', 'bytes')

   if (lastModified) {
      res.set('Last-Modified', lastModified.toUTCString())
   }
   if (eTag) {
      res.set('ETag', eTag)
   }
   if (req.get('x-bc-no-content-length') !== 'true') {
      res.set('Content-Length', contentLength)
   }

   // Content type
   if (contentType) {
      res.type(contentType)
   }
   if (!req.accepts(contentType)) {
      return next(new HttpError.NotAcceptable())
   }

   if (req.cacheControlResponse) res.set('Cache-Control', req.cacheControlResponse)

   let range = req.range(contentLength, { combine: true })

   if (range === -2) {
      const err = new HttpError.BadRequest('Malformed \'Range\' header')
      err.exposedProperties = { requestRangeHeader: req.get('Range') }
      logger.warn(`Malformed 'Range' header: ${req.get('Range')}`)
      return next(err)
   } else if (range === -1 || (range && range.type !== 'bytes')) {
      // Set Content-Range to show allow range
      res.set('Content-Range', `bytes */${contentLength}`)
      const err = new HttpError.RangeNotSatisfiable()
      err.exposedProperties = { requestRangeHeader: req.get('Range'), maxContentLength: contentLength }
      logger.warn(`Unsatisfiable 'Range' header: ${req.get('Range')} - max size: ${contentLength}`)
      return next(err)
   } else if (Array.isArray(range) && range.length > 1) {
      // Ignore range if multiples are provided
      range = null
   }

   const streamOpts = {}

   // Checks

   range = getRange(req.get('If-Range'), lastModified, eTag, range)

   if (range) {
      // Serve range

      const r = range[0]
      streamOpts.range = {
         start: r.start,
         end: r.end
      }

      res.set('Content-Range', `bytes ${r.start}-${r.end}/${contentLength}`)
      res.set('Content-Length', (r.end - r.start) + 1)

      res.status(206)
   } else {
      // Serve complete data

      // Etag
      if (eTag) {
         const reqETag = req.get('If-None-Match')
         if (reqETag === eTag) {
            logger.verbose('Resource unmodified based on eTag')
            // Not modified
            return res.status(304).end()
         }
      }

      // Last modified
      if (lastModified && !(req.get('If-None-Match') || req.get('If-Range'))) {
         const modifiedSince = (() => {
            const d = req.get('If-Modified-Since')
            return d ? new Date(d) : null
         })()
         if (modifiedSince && (lastModified.getTime() <= modifiedSince.getTime())) {
            logger.verbose('Resource unmodified based on update time')
            // Not modified
            return res.status(304).end()
         }
      }

      res.status(200)
   }

   // Stream
   const stream = req.gcsFile.createReadStream(streamOpts.range)
   pipeStream({
      tag: 'gcsFileStreamer',
      source: req.gcsFile.name,
      query: req.query
   }, stream, res, next)
}


const getRange = (ifRange, lastModified, eTag, requestRange) => {

   // Serve requested range
   if (requestRange && !ifRange) return requestRange

   if (ifRange && requestRange) {
      // If-Range is only valid if there's also a Range header

      const ifRangeAsDate = (r => {
         let d
         try {
            d = new Date(r)
         } catch (ex) {
            // Bad date
         }
         return isNaN(d) ? null : d
      })(ifRange)

      if (ifRangeAsDate) {
         // No last modified to compare so serve back all data
         if (!lastModified) return null

         // Resource stale
         if (lastModified.getTime() > ifRangeAsDate.getTime()) {
            logger.verbose('Resource stale based on If-Range last modified')
            return null
         }

         // Range data still valid - serve back
         return requestRange
      }

      // Fallback to eTag base range checking
      if (eTag) {
         if (ifRange === eTag) {
            return requestRange
         }

         logger.verbose('Resource stale based on If-Range eTag')
      }
   }

   // Fallback to serving all data
   return null

}

const pipeStream = ({ tag, source, query }, inputStream, res, next) => {
   let readStream = inputStream
   readStream.on('error', err => {
      if (err.message) {
         if (err.message.indexOf('unsupported image format') !== -1) logger.error(`[${tag}] Image could not be processed`, source)
         if (err.message.indexOf(': image has shrunk to nothing') !== -1) {
            logger.error(`[${tag}] Image was shrunk to a zero size - ${query.width}x${query.height}`, source)
            const e = new HttpError.BadRequest('Requesting 0 sized image')
            e.underlyingErr = err
            e.tag = tag
            e.source = source
            e.query = query
            err = e
         }
         if (err.message.indexOf('extract_area: parameter height not set') !== -1) logger.error(`[${tag}] extract_area: parameter height not set - ${query.width}x${query.height}`, source)
      }
      readStream.unpipe(res)
      killStream(inputStream, err)
      next(handleGCSReadError(err))
   })
   readStream.pipe(res)
}

const GatewayTimeoutErrors = new Set([
   'ETIMEDOUT',
   'ESOCKETTIMEDOUT'
])

const handleGCSReadError = err => {
   let e
   if (err instanceof HttpError.HttpError) {
      e = err
   } else if (GatewayTimeoutErrors.has(err.code)) {
      e = new HttpError.GatewayTimeout(err.message)
   } else if (Math.floor(err.code / 100) === 4) {
      e = HttpError(err.code, err.message)
   } else if (Math.floor(err.code / 100) === 5) {
      e = new HttpError.BadGateway(err.message)
   } else {
      e = new HttpError.InternalServerError(err.message)
   }
   if (e !== err) e.underlyingErr = err
   e.type = 'gcs-read-stream'
   return e
}

const killStream = module.exports.killStream = (stream, err) => {
   if (typeof stream.destroy === 'function') {
      stream.destroy()
   } else if (typeof stream.abort === 'function') {
      stream.abort()
   } else {
      logger.error('Stream cannot be destroyed or aborted with error:', err)
   }
}
