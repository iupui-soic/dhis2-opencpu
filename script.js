// To be implemented later

document.getElementById('runCode').addEventListener('click', function() {
    var datasetId = document.getElementById('dataset-dropdown').value;
    var code = document.getElementById('codeInput').value.trim();
    var resultContainer = document.getElementById('response-output');

    resultContainer.textContent = "Running...";

    // Adjust the OpenCPU API endpoint for running R code on datasets
    var xhr = new XMLHttpRequest();
    xhr.open('GET', `https://play.dhis2.org/40.3.0/api/29/datasets/${datasetId}/runRCode`, true);
    xhr.setRequestHeader('Content-Type', 'application/json');

    // Pass the R code as a parameter
    var params = {
        rCode: code
    };

    xhr.onreadystatechange = function() {
        if(xhr.readyState === XMLHttpRequest.DONE) {
            var status = xhr.status;
            if (status === 0 || (status >= 200 && status < 400)) {
                // The request has been completed successfully
                resultContainer.textContent = xhr.responseText;
            } else {
                // Oh no! There has been an error with the request!
                resultContainer.textContent = "Error: " + xhr.statusText;
            }
        }
    };
    xhr.send(JSON.stringify(params));
});


document.getElementById('runCode').addEventListener('click', function() {
    var code = document.getElementById('codeInput').value.trim();
    var resultContainer = document.getElementById('response-output');

    resultContainer.textContent = "Running...";

    // Adjust the OpenCPU API endpoint for running R code
    var xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://cloud.opencpu.org/ocpu/library/stats/R', true); // Adjust the endpoint
    xhr.setRequestHeader('Content-Type', 'application/json');

    // Pass the R code as a parameter
    var params = {
        code: code
    };

    xhr.onreadystatechange = function() {
        if(xhr.readyState === XMLHttpRequest.DONE) {
            var status = xhr.status;
            if (status === 0 || (status >= 200 && status < 400)) {
                // The request has been completed successfully
                resultContainer.textContent = xhr.responseText;
            } else {
                // There has been an error with the request!
                resultContainer.textContent = "Error: " + xhr.statusText;
            }
        }
    };
    xhr.send(JSON.stringify(params));
});