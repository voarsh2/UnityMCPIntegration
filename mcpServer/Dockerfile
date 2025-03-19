FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code and TypeScript config
COPY tsconfig.json ./
COPY src/ ./src/

# Build the application
RUN npm run build

# Expose WebSocket port (will be overridden if MCP_WEBSOCKET_PORT env is set)
EXPOSE 8080

# Set environment variables with default values
ENV MCP_WEBSOCKET_PORT=8080

# Command to run the MCP server
CMD ["node", "build/index.js"]
