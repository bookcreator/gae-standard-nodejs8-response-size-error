const winston = require('winston')

const baseOptions = {
   prettyPrint: true,
   timestamp: true
}

function makeLogger(forGAE, logName) {
   const opts = Object.assign({}, baseOptions)
   opts.labels = Object.assign({}, opts.labels)
   if (logName) opts.logName = logName

   /* istanbul ignore if */
   if (forGAE) {

      // eslint-disable-next-line global-require
      require('@google-cloud/logging-winston')

      const baseStackDriverOptions = Object.assign({}, opts)
      // aef-api-20180608t232542-xcxx
      baseStackDriverOptions.labels.instance = process.env.GAE_INSTANCE.replace(new RegExp(`^aef-${process.env.GAE_SERVICE}-${process.env.GAE_VERSION}-`), '')

      const ts = [
         new winston.transports.StackdriverLogging(baseStackDriverOptions)
      ]
      const exs = [
         new winston.transports.StackdriverLogging(Object.assign({ humanReadableUnhandledException: true }, baseStackDriverOptions))
      ]

      return new winston.Logger({
         level: 'debug',
         transports: ts,
         exceptionHandlers: exs
      })
   }

   const baseDebugOptions = Object.assign({ colorize: 'all' }, opts)

   return new winston.Logger({
      level: 'debug',
      transports: [
         new winston.transports.Console(baseDebugOptions)
      ],
      exceptionHandlers: [
         new winston.transports.Console(Object.assign({ humanReadableUnhandledException: true }, baseDebugOptions))
      ]
   })
}

function createLogger(forGAE, logName) {
   /* istanbul ignore if */
   if ('logger' in global) return global.logger
   return makeLogger(forGAE, logName)
}

global.logger = createLogger(process.env.GAE_SERVICE)

console.log(`${new Date().toISOString()} - Global logger level: ${logger.level}`)
logger.verbose('Logging setup')

module.exports = makeLogger.bind(null, process.env.GAE_SERVICE)

/* istanbul ignore if */
if (process.env.GAE_SERVICE) {
   const memUsageLogger = module.exports('mem-usage')
   const os = require('os') // eslint-disable-line global-require
   const memoryUsage = warn => {
      memUsageLogger.info('Process memory usage:', process.memoryUsage())
      const used = os.totalmem() - os.freemem()
      const pct = used / os.totalmem()
      let msg = `System memory usage - ${(100 * (pct)).toFixed(2)} % ${(used / (1024 * 1024)).toFixed(3)}/${(os.totalmem() / (1024 * 1024)).toFixed(3)}`
      const stats = {
         ratio: os.freemem() / os.totalmem(),
         free: os.freemem(),
         used,
         total: os.totalmem()
      }
      if (pct >= 0.75 || warn) {
         if (warn) {
            msg = `[${warn.prefix}] ${msg}`
            stats.data = warn.data
         }
         memUsageLogger.warn(msg, stats)
      } else {
         memUsageLogger.info(msg, stats)
      }
   }
   setInterval(memoryUsage, process.env.DEBUG ? 20000 : /* istanbul ignore next */60000)
   memoryUsage()

   process.prependListener('uncaughtException', /* istanbul ignore next */ ex => {
      memoryUsage({
         prefix: 'uncaughtException',
         data: ex
      })
   })
}