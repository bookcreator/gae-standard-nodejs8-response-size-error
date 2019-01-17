if (process.env.GAE_SERVICE) {
   /* eslint-disable global-require */
   require('@google-cloud/trace-agent').start({
      ignoreUrls: [
         '/_ah/health',
         '/readiness_check',
         '/liveness_check'
      ]
   })
   require('@google-cloud/debug-agent').start({
      allowExpressions: true,
      capture: {
         maxExpandFrames: 10
      }
   })
   /* eslint-enable global-require */
}

require('./logging')

const express = require('express')
const HttpError = require('http-errors')

process.on('uncaughtException', ex => {
   if (!process.env.DEBUG) console.error('uncaughtException', ex)
   if (global['logger']) logger.error('uncaughtException', ex)
   throw ex
})
process.on('unhandledRejection', reason => console.error('Unhandled Promise rejection:', reason))

logger.info(`${process.env.GAE_SERVICE || 'DEBUG'} - Node version: ${process.version}`)

const app = express()
app.disable('x-powered-by')

if (!process.env.DEBUG) {
   app.enable('trust proxy')
}

app.set('json spaces', 3)

if (process.env.GAE_SERVICE) {
   app.use((req, res, next) => {
      res.set('x-served-by', `${process.env.GAE_SERVICE}/${process.env.GAE_VERSION}`)

      req.trace = Object.freeze({
         context: req.get('x-cloud-trace-context'),
         logId: req.get('x-appengine-request-log-id')
      })

      next()
   })
} else {
   app.use('/html', express.static('html'))
}

app.use((req, res, next) => {
   logger.verbose(`Incoming request: ${req.method} - ${req.url}`, process.env.DEBUG ? undefined : req.headers)
   next()
})

// App engine warmup requests
app.get('/_ah/warmup', (req, res) => {
   logger.info('[WARMUP]', 'Success')
   res.status(200).end('OK')
})

if (process.env.DEBUG) app.use(require('morgan')('dev')) // eslint-disable-line global-require

app.use(require('./middleware'))

// catch 404 and forward to error handler
app.use((req, res, next) => {
   next(new HttpError.NotFound())
})

// error handler
app.use((err, req, res, next) => {
   if (res.headersSent) {
      return next(err)
   }

   // render the error page
   let status = err.status
   if (typeof err.code === 'number' && err.code > 0) {
      status = status || err.code
   }
   if (status < 100 || status >= 600) {
      err.originalStatus = status
      status = 500
   }
   status = status || 500
   res.status(status)

   const exposedProperties = err.exposedProperties || {}
   delete err.exposedProperties
   if (req.trace) exposedProperties.trace = req.trace

   const errObj = {
      path: req.originalUrl,
      trace: req.trace
   }

   logger.error('Error middleware:', err, errObj)
   const errorDetail = {
      status,
      type: err.constructor.name,
      message: err.message
   }
   if (!process.env.GAE_SERVICE) {
      errorDetail.stack = err.stack
   }
   // Provide error in development
   res.json(Object.assign(errorDetail, exposedProperties, err))
})

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
   const middleware = {}
   Error.captureStackTrace(middleware)
   err.routerStack = middleware.stack
   logger.warn('Error after response headers have been sent:', err)
})

module.exports = app

