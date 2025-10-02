FROM node:18-slim
WORKDIR /app

ARG PORT=3000
ENV PORT=${PORT}
ENV NODE_ENV=development

# Copy dependency files first (better for caching)
# Use relative paths since WORKDIR is already set
COPY package.json ./
COPY package-lock.json ./

# Install dependencies including development ones
RUN npm install

# Install nodemon globally
RUN npm install -g nodemon

# Copy the rest of the application files
COPY . ./

# Expose the defined port
EXPOSE ${PORT}

# Start server using npm script
CMD ["npm", "run", "dev"]