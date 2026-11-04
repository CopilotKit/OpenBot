pub(crate) type CapturedRequests = Vec<(String, Vec<u8>)>;

pub(crate) fn response_server(
    responses: Vec<(&'static str, &'static str)>,
) -> (String, std::thread::JoinHandle<CapturedRequests>) {
    use std::io::{BufRead, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let request = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in responses {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = std::io::BufReader::new(stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                headers.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap_or(0);
            let mut request_body = vec![0; length];
            reader.read_exact(&mut request_body).unwrap();
            write!(reader.get_mut(), "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            requests.push((headers, request_body));
        }
        requests
    });
    (url, request)
}
