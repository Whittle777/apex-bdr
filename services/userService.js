const bcrypt = require('bcrypt');

const prisma = require('./database');
async function registerUser(email, password, name) {
  const hashedPassword = await bcrypt.hash(password, 10);

  // Auto-generate username from the email local part
  let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
  let username = baseUsername;

  // Append a random 4-digit suffix if the username is already taken
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    username = `${baseUsername}${suffix}`;
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashedPassword,
      username,
      name: name || null,
    },
  });
  return user;
}

async function loginUser(email, password) {
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return null;
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);
  if (!isPasswordValid) {
    return null;
  }

  return user;
}

module.exports = {
  registerUser,
  loginUser,
};
