const https = require("https");
const AWS = require("aws-sdk");
const urlParse = require("url").URL;
const appsyncUrl = process.env.API_PECUNIARY_GRAPHQLAPIENDPOINTOUTPUT;
const region = process.env.REGION;
const endpoint = new urlParse(appsyncUrl).hostname.toString();
const apiKey = process.env.API_PECUNIARY_GRAPHQLAPIKEYOUTPUT;
const parameterStore = new AWS.SSM();

exports.handler = async e => {
  var event = JSON.parse(e.Records[0].Sns.Message).message;
  console.log("Event received:\n", event);

  if (await timeSeriesExistsForSymbol(event.data.symbol)) {
    // TOOD Update TimeSeries
  } else {
    console.log("TimeSeries doesn't exist. Creating...");

    // Get the TimeSeries symbol
    var timeSeriesSymbol = await getSymbol(event.data.symbol);
    console.log(`TimeSeriesSymbol for ${event.data.symbol}:\n`, timeSeriesSymbol);

    // Get the TimeSeries quote
    var timeSeriesQuote = await getQuote(event.data.symbol);
    console.log(`TimeSeriesQuote for ${event.data.symbol}:\n`, timeSeriesQuote);

    // Create TimeSeries
    await createTimeSeries(timeSeriesSymbol, timeSeriesQuote, event.data.symbol);
  }

  console.log(`Successfully processed ${e.Records.length} record(s)`);
};

const getParam = param => {
  return new Promise((res, rej) => {
    parameterStore.getParameter(
      {
        Name: param
      },
      (err, data) => {
        if (err) {
          return rej(err);
        }
        return res(data);
      }
    );
  });
};

async function createTimeSeries(timeSeriesSymbol, timeSeriesQuote, symbol) {
  var createTimeSeriesMutation = `mutation createTimeSeries {
    createTimeSeries(input: {
      symbol: "${symbol}"
      name: "${timeSeriesSymbol["2. name"]}"
      type: "${timeSeriesSymbol["3. type"]}"
      region: "${timeSeriesSymbol["4. region"]}"
      currency: "${timeSeriesSymbol["8. currency"]}"
      date: "${timeSeriesQuote["07. latest trading day"]}"
      open: ${timeSeriesQuote["02. open"]}
      high: ${timeSeriesQuote["03. high"]}
      low: ${timeSeriesQuote["04. low"]}
      close: ${timeSeriesQuote["05. price"]}
      volume: ${timeSeriesQuote["06. volume"]}
    })
    {
      id
    }
  }`;
  console.debug("createTimeSeries:\n", createTimeSeriesMutation);

  var result = await graphqlOperation(createTimeSeriesMutation, "createTimeSeries");
  console.log("Created TimeSeries:\n", result);
}

async function getTimeSeries(symbol) {
  // TODO Add condition to match the current transaction date
  let getTimeSeriesQuery = `query getTimeSeries {
    listTimeSeriess(filter: {
      symbol: {
        eq: "${symbol}"
      }
    })
    {
      items{
        id
      }
    }
  }`;
  console.debug("getTimeSeries:\n", getTimeSeriesQuery);

  var timeSeries = await graphqlOperation(getTimeSeriesQuery, "getTimeSeries");
  console.log("TimeSeries: %j", timeSeries);

  return timeSeries;
}

async function timeSeriesExistsForSymbol(symbol) {
  // Get any existing TimeSeries for symbol
  let timeSeries = await getTimeSeries(symbol);

  try {
    if (timeSeries.data.listTimeSeriess.items.length > 0) {
      return true;
    }
  } catch (error) {
    return false;
  }

  return false;
}

// Call AlphaVantage to get a SYMBOL_SEARCH
async function getSymbol(symbol) {
  const param = await getParam("AlphaVantageApiKey");

  var result = await get(
    `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${symbol}&apikey=${param.Parameter.Value}`
  );

  if (result["Error Message"]) {
    console.error("Error: ", result["Error Message"]);

    // Default to $0 for quotes not found
    return {
      "1. symbol": `${symbol}`,
      "2. name": "",
      "3. type": "",
      "4. region": "",
      "5. marketOpen": "",
      "6. marketClose": "",
      "7. timezone": "",
      "8. currency": "0",
      "9. matchScore": "0"
    };
  }

  return result["bestMatches"][0];
}

// Call AlphaVantage to get a GLOBAL_QUOTE
async function getQuote(symbol) {
  const param = await getParam("AlphaVantageApiKey");

  var result = await get(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${param.Parameter.Value}`
  );

  if (result["Error Message"]) {
    console.error("Error: ", result["Error Message"]);

    // Default to $0 for quotes not found
    return {
      "01. symbol": `${symbol}`,
      "02. open": "0",
      "03. high": "0",
      "04. low": "0",
      "05. price": "0",
      "06. volume": "0",
      "07. latest trading day": `${new Date().toISOString.substring(0, 10)}`,
      "08. previous close": "0",
      "09. change": "0",
      "10. change percent": "0%"
    };
  }

  return result["Global Quote"];
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      res.setEncoding("utf8");
      let body = "";

      res.on("data", chunk => {
        body += chunk;
      });

      res.on("end", () => {
        resolve(JSON.parse(body));
      });
    });

    req.on("error", err => {
      reject(err);
    });

    req.end();
  });
}

async function graphqlOperation(query, operationName) {
  const req = new AWS.HttpRequest(appsyncUrl, region);

  req.method = "POST";
  req.headers.host = endpoint;
  req.headers["Content-Type"] = "application/json";
  req.body = JSON.stringify({
    query: query,
    operationName: operationName
  });

  if (apiKey) {
    req.headers["x-api-key"] = apiKey;
  } else {
    const signer = new AWS.Signers.V4(req, "appsync", true);
    signer.addAuthorization(AWS.config.credentials, AWS.util.date.getDate());
  }

  const data = await new Promise((resolve, reject) => {
    const httpRequest = https.request({ ...req, host: endpoint }, result => {
      result.on("data", data => {
        resolve(JSON.parse(data.toString()));
      });
    });

    httpRequest.write(req.body);
    httpRequest.end();
  });

  return data;
}
