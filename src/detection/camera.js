/**
 * camera.js
 *
 * Manages the device camera stream for iPhone Safari.
 *
 * Key Safari/iOS quirks handled here:
 *  1. Must request the REAR camera via facingMode: 'environment'
 *  2. Requires HTTPS — will silently fail on HTTP
 *  3. iOS requires a user gesture before calling getUserMedia
 *     (we satisfy this via the "Start Camera" button in the UI)
 *  4. The video element must be muted and have playsinline attribute
 *     or iOS will go full-screen and break the layout
 *  5. Camera resolution: we request 1280x720 (720p). iOS may give us
 *     something different — we always use the ACTUAL video dimensions,
 *     never assume the requested ones.
 */

export class Camera {
  constructor() {
    this.videoEl = null       // the <video> DOM element
    this.stream = null        // MediaStream from getUserMedia
    this.isRunning = false
  }

  /**
   * Attach this camera to an existing <video> element in the DOM.
   * Call this once during UI setup, before start().
   */
  attach(videoElement) {
    this.videoEl = videoElement
  }

  /**
   * Request camera permission and start the stream.
   * Returns a Promise that resolves when video is playing,
   * or rejects with a user-readable error message.
   *
   * IMPORTANT: This must be called from a user gesture handler
   * (e.g. a button click) — not automatically on page load.
   * iOS will silently deny automatic camera access.
   */
  async start() {
    if (!this.videoEl) {
      throw new Error('Camera not attached to a video element. Call attach() first.')
    }

    // Constraints: rear camera, 720p preferred.
    // 'ideal' means "try for this, but don't fail if unavailable".
    // We do NOT use 'exact' because that causes hard failures on some devices.
    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },   // rear camera
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
      // Translate browser error codes into readable messages
      throw new Error(this._friendlyError(err))
    }

    // Wire the stream to the video element
    this.videoEl.srcObject = this.stream

    // Wait for the video to actually be playing before we return.
    // This is important: if we try to capture frames before 'playing',
    // we get blank black frames.
    await this._waitForPlaying()

    this.isRunning = true

    return {
      width:  this.videoEl.videoWidth,
      height: this.videoEl.videoHeight,
    }
  }

  /**
   * Stop the camera and release the hardware.
   * Always call this when navigating away or when done measuring.
   * On iOS, not releasing the camera keeps the green dot in the status bar.
   */
  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    if (this.videoEl) {
      this.videoEl.srcObject = null
    }
    this.isRunning = false
  }

  /**
   * Capture the current video frame onto a canvas element and return
   * the ImageData for marker detection.
   *
   * @param {HTMLCanvasElement} canvas - must match video dimensions
   * @returns {ImageData} raw pixel data, or null if video isn't ready
   */
  captureFrame(canvas) {
    if (!this.isRunning || !this.videoEl) return null

    const w = this.videoEl.videoWidth
    const h = this.videoEl.videoHeight

    if (w === 0 || h === 0) return null   // video not ready yet

    // Sync canvas size to actual video dimensions.
    // This is critical — if canvas != video size, coordinates are wrong.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width  = w
      canvas.height = h
    }

    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    // Note: we do NOT mirror the image here.
    // The rear camera on iPhone should already be correct orientation.
    // If you were using the front camera you'd need: ctx.scale(-1, 1)
    ctx.drawImage(this.videoEl, 0, 0, w, h)

    return ctx.getImageData(0, 0, w, h)
  }

  /**
   * Get actual video dimensions after stream starts.
   * Always use these — never assume the requested dimensions.
   */
  getDimensions() {
    if (!this.videoEl) return { width: 0, height: 0 }
    return {
      width:  this.videoEl.videoWidth,
      height: this.videoEl.videoHeight,
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────

  /**
   * Wait for the video element to emit 'playing'.
   * iOS can take 300-800ms between srcObject assignment and first frame.
   * We also set a 10s timeout so we don't hang forever.
   */
  _waitForPlaying() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Camera timed out — video never started playing.'))
      }, 10_000)

      const onPlaying = () => {
        clearTimeout(timeout)
        this.videoEl.removeEventListener('playing', onPlaying)
        resolve()
      }

      this.videoEl.addEventListener('playing', onPlaying)

      // play() is required on iOS — the video won't auto-play
      this.videoEl.play().catch(reject)
    })
  }

  /**
   * Map browser DOMException names to readable error messages.
   * These are the errors your users will actually hit.
   */
  _friendlyError(err) {
    switch (err.name) {
      case 'NotAllowedError':
        return 'Camera permission denied. Please allow camera access in your iPhone Settings → Safari → Camera.'
      case 'NotFoundError':
        return 'No camera found on this device.'
      case 'NotReadableError':
        return 'Camera is in use by another app. Close other apps and try again.'
      case 'OverconstrainedError':
        return 'Camera does not support the requested settings. Try a different device.'
      case 'SecurityError':
        return 'Camera blocked — this page must be served over HTTPS. Check your Vite config.'
      default:
        return `Camera error: ${err.message || err.name}`
    }
  }
}
