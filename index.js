const express = require('express')
const app = express()
const port = process.env.PORT || 3000

app.get('/', (req, res) => {
  res.send('Blood Aid Server is Running')
})

app.listen(port, () => {
  console.log(`Blood Aid Application listening on port ${port}`)
})
