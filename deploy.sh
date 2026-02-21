#!/bin/bash
set -e

# Configuration
EC2_HOST="3.95.169.108"
EC2_USER="ubuntu"
SSH_KEY="${SSH_KEY:-../rsc.com-infra/rsc-deploy-key.pem}"  # Override with: SSH_KEY=/path/to/key ./deploy.sh
IMAGE_NAME="nateabele/duino-app"
IMAGE_TAG="latest"

echo "=== DuinoApp Deployment Script ==="
echo ""

# Check for SSH key
if [ ! -f "$SSH_KEY" ]; then
    echo "Error: SSH key not found at $SSH_KEY"
    echo "Set SSH_KEY environment variable to your private key path:"
    echo "  SSH_KEY=/path/to/your/key.pem ./deploy.sh"
    exit 1
fi

# Step 1: Build Docker image for AMD64 (EC2 architecture)
echo "[1/3] Building Docker image for linux/amd64..."
docker build --platform linux/amd64 -t ${IMAGE_NAME}:${IMAGE_TAG} .

# Step 2: Push to Docker Hub
echo "[2/3] Pushing image to Docker Hub..."
docker push ${IMAGE_NAME}:${IMAGE_TAG}

# Step 3: Pull and restart on EC2
echo "[3/3] Pulling image and restarting container on EC2..."
ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no ${EC2_USER}@${EC2_HOST} << REMOTE_SCRIPT
set -e
echo "       Pulling latest image..."
sudo docker pull ${IMAGE_NAME}:${IMAGE_TAG}

echo "       Stopping old container..."
sudo docker stop duinoapp || true

echo "       Removing old container..."
sudo docker rm duinoapp || true

echo "       Starting new container..."
sudo docker run -d --name duinoapp --restart unless-stopped --network ubuntu_default --tmpfs /tmp:exec,size=512m -p 3030:3030 ${IMAGE_NAME}:${IMAGE_TAG}

echo "       Cleaning up old images..."
sudo docker image prune -f

echo "       Container status:"
sudo docker ps | grep duinoapp
REMOTE_SCRIPT

echo ""
echo "=== Deployment Complete ==="
echo "Verify at: https://compiler.robotsummer.camp/v3/info/server"
