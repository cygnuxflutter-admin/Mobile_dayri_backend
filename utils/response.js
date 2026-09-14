function removeSensitiveFields(value) {
  if (Array.isArray(value)) {
    return value.map(removeSensitiveFields);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["password", "passwordHash", "confirmPassword"].includes(key))
      .map(([key, entry]) => [key, removeSensitiveFields(entry)]),
  );
}

function sendSuccess(response, statusCode, message, data = null) {
  return response.status(statusCode).json({
    success: true,
    message,
    data: removeSensitiveFields(data),
  });
}

module.exports = { sendSuccess };
