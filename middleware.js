const express = require('express')
const Storage = require('@google-cloud/storage')
const gcsFileStreamer = require('./gcs-streamer')

const storageOpts = {}
if (!process.env.GAE_SERVICE) storageOpts.keyFilename = './bookcreator-dev.json'
const gcs = new Storage(storageOpts)
const bucket = gcs.bucket('bc-gae-test')

const route = express.Router()

route.get('/file/:name', (req, res, next) => {
   const file = bucket.file(req.params.name)
   file.getMetadata(err => {
      if (err) return next(err)
      req.gcsFile = file
      return next()
   })
}, gcsFileStreamer)

module.exports = route
