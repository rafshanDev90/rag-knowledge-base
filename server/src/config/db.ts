import mongoose from 'mongoose';
import { config } from './env.js';

export const connectDB = async (): Promise<void> => {
  try {
    // Senior Trick: Mongoose has a strictQuery setting. 
    // Setting it to true ensures that queries only search for fields defined in your schema.
    mongoose.set('strictQuery', true);
    
    const conn = await mongoose.connect(config.mongoUri);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ Error connecting to MongoDB:`, error);
    process.exit(1); // Exit process with failure
  }
};