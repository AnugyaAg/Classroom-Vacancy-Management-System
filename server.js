const express = require('express');
const mysql = require('mysql2/promise'); // Use promise version of mysql2
const bodyParser = require('body-parser');
const schedule = require('node-schedule');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const PriorityQueue = require('js-priority-queue');

const app = express();
require('dotenv').config();

// Middleware to parse incoming JSON requests
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'Public'))); // Correctly serve static files

// Connect to the MySQL database
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
};

// Logs Directory
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Setup morgan logging - Log to a file
const logStream = fs.createWriteStream(path.join(logsDir, 'requests.log'), { flags: 'a' });
app.use(morgan('combined', { stream: logStream }));
const daysOfWeek1 = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function calculatePriority(role, type, requestTime) {
    // Priority values for role and type
    const rolePriority = { Senior: 1, Junior: 2, Student: 3 }; // Lower value = higher priority
    const typePriority = { Exam: 1, ExtraClass: 2, Event: 3 }; // Lower value = higher priority

    // Convert request time to timestamp for tie-breaking
    const timePriority = new Date(requestTime).getTime();

    // Combine priorities
    return rolePriority[role] * 100 + typePriority[type] * 10 + timePriority / 1000000;
}




// Priority Queues for Each Room
const roomQueues = {};

// Truncate Bookings for Previous Days
async function truncateBookingForPreviousDays() {
    const connection = await mysql.createConnection(dbConfig);
    try {
        const currentDay = new Date().getDay();
        console.log(`Current day (numeric): ${currentDay} - ${daysOfWeek1[currentDay]}`);

        for (let i = 1; i <= currentDay; i++) {
            const previousDay = (currentDay - i + 7) % 7;
            console.log(`Truncating bookings for day: ${daysOfWeek1[previousDay]}`);

            await connection.execute(`DELETE FROM Booking WHERE day_of_week = ?;`, [daysOfWeek1[previousDay]]);
        }
    } catch (error) {
        console.error('Error truncating bookings for previous days:', error);
    } finally {
        connection.end();
    }
}

truncateBookingForPreviousDays();

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'Public', 'index.html'), (err) => {
        if (err) {
            res.status(err.status || 500).send('Error loading page');
        }
    });
});

// Use async function to connect to the database
(async () => {
    try {
        const db = await mysql.createConnection(dbConfig);
        console.log('Connected to MySQL database');

        // Search Available Rooms
        app.get('/search-room', async (req, res) => {
            const { timeslot, block, dayofweek } = req.query;
        
            // Validate query parameters
            if (!timeslot || !block || !dayofweek) {
                return res.status(400).send('Missing required query parameters.');
            }
        
            // Extract start and end time from timeslot
            const [startTime, endTime] = timeslot.split('-');
        
            // Query to fetch available rooms
            const availableRoomsQuery = `
                SELECT room_number, block, floor, capacity
                FROM Classrooms
                WHERE block = ?
                AND available = 1 -- Adjust for 1 (TRUE) in the availability column
                AND (locked_until IS NULL OR locked_until <= NOW())
                AND room_number NOT IN (
                    SELECT room_number
                    FROM Booking
                    WHERE day_of_week = ?
                    AND start_time < ?
                    AND end_time > ?
                );
            `;
        
            try {
                // Execute the query with parameters
                const [result] = await db.query(availableRoomsQuery, [
                    block, dayofweek, endTime, startTime,
                ]);
        
                // Check if any rooms are available
                if (result.length > 0) {
                    let classroomsHtml = `
                        <div class="available-classrooms">
    <h2>Available Classrooms</h2>
    <div class="classroom-card-container">
        ${result.map(classroom => `
            <div class="classroom-card">
                <div class="classroom-icon">&#127979;</div> <!-- A classroom icon -->
                <h2>Classroom ${classroom.room_number}</h2>
                <p><strong>Status:</strong> <span class="available">Available</span></p>
            </div>
        `).join('')}
    </div>
</div>`;

                    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Classroom Search Results</title>
        <style>
            body {
                font-family: 'Arial', sans-serif;
                background-image: url('https://collegewaale.com/upes/wp-content/uploads/2023/12/upes-1-1024x768.webp');
                background-size: cover;
                margin: 0;
                padding: 0;
            }
            .container {
                width: 90%;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background-color: rgba(255, 255, 255, 0.3); /* Light transparency for better visibility */
                border-radius: 10px;
                backdrop-filter: blur(10px); /* Enhanced blur effect */
            }
            .header {
                text-align: center;
            }
            .header img {
                width: 150px; /* Adjust logo size as needed */
                margin-bottom: 20px;
            }
            h1 {
                color: #333;
                margin-bottom: 20px;
                text-shadow: 1px 1px 3px rgba(255, 255, 255, 0.8); /* Added text shadow */
            }
            .available-classrooms {
                display: flex;
                flex-direction: column;
                align-items: center;
            }
            .classroom-card-container {
                display: flex;
                flex-wrap: wrap;
                gap: 16px;
                justify-content: center;
            }
            .classroom-card {
                background-color: white;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                padding: 20px;
                width: 100%;
                max-width: 300px;
                transition: transform 0.3s ease, box-shadow 0.3s ease;
                text-align: center;
            }
            .classroom-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 8px 16px rgba(0, 0, 0, 0.2);
            }
            .classroom-card h2 {
                font-size: 20px;
                color: #444;
                margin-bottom: 10px;
                text-shadow: 1px 1px 2px rgba(255, 255, 255, 0.8); /* Added text shadow */
            }
            .classroom-icon {
                font-size: 50px;
                color: #3498db;
                margin-bottom: 10px;
            }
            .available {
                color: #2ecc71;
                font-weight: bold;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <img src="https://indiaeducationdiary.in/wp-content/uploads/2022/01/UPES-LOGO-01.jpg" alt="UPES Logo">
                <h1>Classroom Search Results</h1>
            </div>
            ${classroomsHtml}
        </div>
    </body>
    </html>
`);

                } else {
                    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>No Classrooms Available</title>
        <style>
            body {
                font-family: 'Arial', sans-serif;
                background-image: url('https://collegewaale.com/upes/wp-content/uploads/2023/12/upes-1-1024x768.webp');
                background-size: cover;
                margin: 0;
                padding: 0;
            }
            .container {
                width: 90%;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background-color: rgba(255, 255, 255, 0.3); /* Light transparency for better visibility */
                border-radius: 10px;
                backdrop-filter: blur(10px); /* Enhanced blur effect */
            }
            .no-classrooms {
                text-align: center;
                margin-top: 40px;
            }
            .no-classrooms-icon {
                font-size: 80px;
                color: #e74c3c;
                margin-bottom: 20px;
            }
            .no-classrooms h1 {
                color: #e74c3c;
                font-size: 28px;
                margin-bottom: 10px;
                text-shadow: 1px 1px 3px rgba(255, 255, 255, 0.8); /* Added text shadow */
            }
            .no-classrooms p {
                font-size: 16px;
                color: #666;
            }
            .button {
                display: inline-block;
                padding: 10px 20px;
                margin-top: 20px;
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 5px;
                text-decoration: none;
                font-size: 16px;
                transition: background-color 0.3s;
            }
            .button:hover {
                background-color: #2980b9;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="no-classrooms">
                <div class="no-classrooms-icon">&#128679;</div> <!-- Warning Icon -->
                <h1>No Available Classrooms</h1>
                <p>No available classrooms for ${dayofweek} during ${timeslot} in ${block}. Please try a different time slot or block.</p>
                <a href="javascript:history.back()" class="button">Go Back</a>
            </div>
        </div>
    </body>
    </html>
`);
                }



            } catch (error) {
                console.error('Error executing query', error.stack);
                res.status(500).send('An error occurred while searching for classrooms.');
            }
        });




// POST route for handling login requests
app.post('/login', async (req, res) => {
    // Log the received data to check if it's coming from the frontend
    console.log("Received login request:", req.body);

    const { username, password, role } = req.body;

    // Check if any of the required fields are missing
    if (!username || !password || !role) {
        console.error("Missing required fields:", { username, password, role });
        return res.status(400).send("Missing required fields.");
    }

    // Query to check if the user exists with the correct role and password
    const query = 'SELECT * FROM Users WHERE username = ? AND password = ? AND role = ?';

    try {
        const [results] = await db.query(query, [username, password, role]);

        // Log the query results
        console.log("Query results:", results);

        // Check if we found a matching user
        if (results.length > 0) {
            console.log("Login successful for user:", username);
            res.sendFile(path.join(__dirname, 'Public', 'action.html'));
        } else {
            console.log("Login failed for user:", username);
            res.sendFile(path.join(__dirname, 'Public', 'error.html'));
        }
    } catch (err) {
        console.error("Error during login query:", err);
        res.status(500).send('An error occurred while processing your login request.');
    }
});

        //room booking post request
        const bookingQueue = []; // In-memory queue for booking requests

        
        // Room Booking
        // Room Booking Endpoint with Debug Statements
        // Add '/book-room' route
app.post('/book-room', async (req, res) => {
    console.log("===== Received Booking Request =====");
    console.log("Request Body:", req.body);

    const { roomNumber, block, timeslot, purpose, dayofweek, userRole, bookingType } = req.body;

    // Log each field explicitly
    console.log("Parsed Fields:");
    console.log("Room Number:", roomNumber);
    console.log("Block:", block);
    console.log("Time Slot:", timeslot);
    console.log("Purpose:", purpose);
    console.log("Day of Week:", dayofweek);
    console.log("User Role:", userRole);
    console.log("Booking Type:", bookingType);

    // Check for missing fields and log them
    const missingFields = [];
    if (!roomNumber) missingFields.push("roomNumber");
    if (!block) missingFields.push("block");
    if (!timeslot) missingFields.push("timeslot");
    if (!purpose) missingFields.push("purpose");
    if (!dayofweek) missingFields.push("dayofweek");
    if (!userRole) missingFields.push("userRole");
    if (!bookingType) missingFields.push("bookingType");

    if (missingFields.length > 0) {
        console.error("Missing Required Fields:", missingFields);
        return res.status(400).send(`Missing required fields: ${missingFields.join(", ")}`);
    }

    console.log("All required fields are present. Proceeding with booking logic...");

    const [startTime, endTime] = timeslot.split('-');
    const type = bookingType; // Map bookingType to the priority type
    const requestTime = new Date();

    if (!roomQueues[roomNumber]) {
        roomQueues[roomNumber] = new PriorityQueue({ comparator: (a, b) => a.priority - b.priority });
    }

    const priority = calculatePriority(userRole, type, requestTime);

    roomQueues[roomNumber].queue({
        user: { roomNumber, block, startTime, endTime, purpose, dayofweek, userRole, type },
        priority,
        timestamp: Date.now(),
        res,
    });

    console.log("Request added to the queue. Current queue for room:", roomQueues[roomNumber]);
    processBookingQueue(db);
});
        // Process Booking Queue
        async function processBookingQueue(db) {
            for (const roomKey in roomQueues) {
                if (!roomQueues[roomKey] || roomQueues[roomKey].length === 0) continue;

                const currentRequest = roomQueues[roomKey].dequeue();
                const { user, res } = currentRequest;
                const { roomNumber, block, startTime, endTime, purpose, dayofweek, userRole, type } = user;

        try {
            const db = await mysql.createConnection(dbConfig);

            // Conflict detection
            const conflictQuery = `
                SELECT *
                FROM Booking
                WHERE room_number = ?
                AND day_of_week = ?
                AND (
                    (start_time < ? AND end_time > ?) OR
                    (start_time < ? AND end_time > ?) OR
                    (start_time >= ? AND end_time <= ?)
                );
            `;
            const [conflicts] = await db.query(conflictQuery, [
                roomNumber, dayofweek, endTime, endTime, startTime, startTime, startTime, endTime,
            ])

            if (conflicts.length > 0) {
                console.log("Booking conflict detected:", conflicts);
                return res.sendFile(path.join(__dirname, 'Public', 'Bookingconflict.html'));
            }

            // Lock room and add booking
            const lockQuery = `
                UPDATE Classrooms
                SET locked_until = NOW() + INTERVAL 5 MINUTE
                WHERE room_number = ? AND available = 1
                AND (locked_until IS NULL OR locked_until <= NOW());
            `;
            const [lockResult] = await db.query(lockQuery, [roomNumber]);

            if (lockResult.affectedRows === 0) {
                console.log("Room is currently locked or unavailable.");
                return res.status(409).send('Room is currently locked or unavailable.');
            }

            const bookQuery = `
                INSERT INTO Booking (room_number, block, day_of_week, start_time, end_time, purpose, user_role, booking_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?);
            `;
            await db.query(bookQuery, [roomNumber, block, dayofweek, startTime, endTime, purpose, userRole, type]);

            console.log(`Room ${roomNumber} booked successfully.`);
            res.sendFile(path.join(__dirname, 'Public', 'bookingconf.html'));
        } catch (error) {
            console.error("Error processing booking:", error);
            res.status(500).send('Error processing booking.');
        }
    }
}

        // Expired Locks Release
        setInterval(async () => {
            const unlockQuery = `UPDATE Classrooms SET locked_until = NULL WHERE locked_until <= NOW();`;
            try {
                await db.query(unlockQuery);
            } catch (error) {
                console.error('Error releasing locks:', error);
            }
        }, 60000);

        // Start the Server
        app.listen(3001, () => {
            console.log('Server running on http://localhost:3001');
        });
    } catch (error) {
        console.error('Error connecting to MySQL:', error.message);
    }
})();