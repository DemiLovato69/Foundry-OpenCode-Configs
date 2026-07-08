export default async () => ({
  config: async (config) => {
    const tabby = config.provider?.tabby
    if (!tabby?.options || typeof tabby.options !== "object") return

    tabby.options.transformRequestBody = (body) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) return body

      delete body.tools
      delete body.tool_choice
      delete body.parallel_tool_calls

      return body
    }
  },
})
