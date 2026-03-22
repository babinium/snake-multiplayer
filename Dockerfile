# Use Node.js 20
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the code
COPY . .

# Expose port (Game runs on 3000)
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
