const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const { authenticateApiKey } = require('../middleware/auth')
const geminiAccountService = require('../services/geminiAccountService')
const unifiedGeminiScheduler = require('../services/unifiedGeminiScheduler')
const crypto = require('crypto')

// This helper function is copied from geminiRoutes.js
function generateSessionHash(req) {
  const sessionData = [
    req.headers['user-agent'],
    req.ip,
    req.headers['x-api-key']?.substring(0, 10)
  ]
    .filter(Boolean)
    .join(':')

  return crypto.createHash('sha256').update(sessionData).digest('hex')
}

// This is a dedicated handler for streaming image model content.
// It's adapted from the generic handler in geminiRoutes.js.
async function handleImageStreamGenerateContent(req, res) {
  let abortController = null
  try {
    const model = 'gemini-2.5-flash-image-preview'
    const sessionHash = generateSessionHash(req)

    // Select an account using the unified scheduler
    const { accountId } = await unifiedGeminiScheduler.selectAccountForApiKey(
      req.apiKey,
      sessionHash,
      model
    )
    const account = await geminiAccountService.getAccount(accountId)

    if (!account) {
      return res
        .status(404)
        .json({ error: { message: 'Selected account not found.', type: 'invalid_request_error' } })
    }

    // Abort controller for client disconnects
    abortController = new AbortController()
    req.on('close', () => {
      if (abortController && !abortController.signal.aborted) {
        logger.info('Client disconnected, aborting image stream request')
        abortController.abort()
      }
    })

    // Call the dedicated service function for image models
    const streamResponse = await geminiAccountService.streamImageModelWithApiKey(
      account,
      { model, request: req.body },
      abortController.signal
    )

    // Set headers for streaming
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    // Pipe the stream from Google API directly to the client
    streamResponse.pipe(res)

    streamResponse.on('end', () => {
      logger.info('Image stream completed successfully')
      res.end()
    })

    streamResponse.on('error', (error) => {
      logger.error('Image stream error:', error)
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: { message: error.message || 'Stream error', type: 'api_error' } })
      }
    })
  } catch (error) {
    logger.error('Error in handleImageStreamGenerateContent endpoint', {
      message: error.message,
      stack: error.stack
    })
    if (!res.headersSent) {
      res
        .status(500)
        .json({ error: { message: error.message || 'Internal server error', type: 'api_error' } })
    }
  } finally {
    if (abortController) {
      abortController = null
    }
  }
  return undefined
}

// Route specifically for the Gemini image model
router.post(
  '/gemini-2.5-flash-image-preview:streamGenerateContent',
  authenticateApiKey,
  handleImageStreamGenerateContent
)

module.exports = router
