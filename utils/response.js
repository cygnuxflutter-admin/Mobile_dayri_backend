function sendSuccess(response, statusCode, message, data = null) {
  return response.status(statusCode).json({
    success: true,
    message,
    data
  });
}

module.exports = { sendSuccess };
